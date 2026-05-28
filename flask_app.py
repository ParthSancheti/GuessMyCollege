import os
import re
import json
import math
import email
import sqlite3
import logging
import traceback
import urllib.request
import urllib.error
from email import policy
import uuid
import random
import string
import hmac
import hashlib
import time
from collections import defaultdict
 
from flask import Flask, request, jsonify
from bs4 import BeautifulSoup

# ==============================================================================
#  RATE LIMITER (in-memory, per-IP)
#  Sliding window: max 5 predict calls per 60 seconds per IP.
# ==============================================================================
_rate_store = defaultdict(list)   # ip -> [timestamp, ...]
RATE_LIMIT_MAX  = 20               # max requests
RATE_LIMIT_SECS = 60              # per window

def _check_rate_limit(ip: str) -> bool:
    """Returns True if request is allowed, False if rate-limited."""
    now = time.time()
    _rate_store[ip] = [t for t in _rate_store[ip] if now - t < RATE_LIMIT_SECS]
    if len(_rate_store[ip]) >= RATE_LIMIT_MAX:
        return False
    _rate_store[ip].append(now)
    return True

  # Read-Only: 28k rows of cutoffs & colleges
USER_DB_PATH = 'Users.db'         # Read/Write: SaaS Accounts, Tokens, Economy
# ------------------------------------------------------------------ logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("score-engine")
 
# --------------------------------------------------- optional dependencies ----
# The core scoring engine MUST work even if razorpay / google-genai are not
# installed. They are imported lazily so a missing package never kills the app.
try:
    from flask_cors import CORS
    _HAS_CORS = True
except Exception:                                       # pragma: no cover
    _HAS_CORS = False
    log.warning("flask_cors not installed - CORS headers added manually.")
 
try:
    import razorpay
    _HAS_RAZORPAY = True
except Exception:                                       # pragma: no cover
    _HAS_RAZORPAY = False
    log.warning("razorpay not installed - payment endpoints will return 503.")
 
try:
    from google import genai
    from google.genai import types
    _HAS_GENAI = True
except Exception:                                       # pragma: no cover
    _HAS_GENAI = False
    log.warning("google-genai not installed - using rule-based advice fallback.")
 
 
# ==============================================================================
#  APP + CONFIG
# ==============================================================================
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024     # 64 MB upload ceiling
 
if _HAS_CORS:
    CORS(app)
else:
    @app.after_request
    def _add_cors(resp):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        return resp
 
# --- API keys ---------------------------------------------------------------
# ┌─────────────────────────────────────────────────────────────────────────┐
# │  GEMINI KEY — paste yours between the quotes below, then save + run.   │
# │  Get it free at: https://aistudio.google.com/app/apikey                │
# └─────────────────────────────────────────────────────────────────────────┘
# --- API keys ---------------------------------------------------------------
GEMINI_KEY = "AIzaSyBOoFr7o-mukVxsQtcJVU5SVJvxt8ONSqM"
RZP_KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "rzp_test_StXFshYiTuu4f0").strip()
RZP_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "nem96TDFvzfgETfysJUTpt64").strip()
_ai_client = None
if _HAS_GENAI and GEMINI_KEY:
    try:
        _ai_client = genai.Client(api_key=GEMINI_KEY)
        log.info("✅ Gemini client ready.  Advice=gemini-2.5-flash  Placement=gemini-2.5-pro")
    except Exception as e:
        log.warning("Gemini init failed (%s) - rule-based advice fallback.", e)
else:
    if not _HAS_GENAI:
        log.warning("⚠️  google-genai not installed.  Run: pip install google-genai")
    else:
        log.warning("⚠️  No GEMINI_API_KEY found — using rule-based fallback."
                    "  Open backend.py and paste your key into GEMINI_KEY_HARDCODED.")
 
_razorpay_client = None
if _HAS_RAZORPAY:
    try:
        _razorpay_client = razorpay.Client(auth=(RZP_KEY_ID, RZP_KEY_SECRET))
    except Exception as e:                              # pragma: no cover
        log.warning("Razorpay init failed: %s", e)
 
 
# ==============================================================================
#  EXAM CONFIGURATION
# ==============================================================================
# Per-exam marking rules. `weights` maps a (normalised) subject -> marks/question.
# `default_weight` covers any subject not explicitly listed.
EXAM_CONFIG = {
    "MHT-CET": {
        "label": "MHT-CET",
        "negative": 0.0,                       # MHT-CET has NO negative marking
        "default_weight": 1,
        "weights": {"Mathematics": 2},         # Maths questions are worth 2
        "scheme": "MHT-CET: +1 per correct (Physics/Chemistry/Biology), "
                  "+2 per correct (Mathematics), no negative marking.",
    },
    "NEET": {
        "label": "NEET (UG)",
        "negative": 1.0,                       # NEET: -1 for a wrong answer
        "default_weight": 4,                   # +4 for a correct answer
        "weights": {},
        "scheme": "NEET: +4 per correct, -1 per incorrect, 0 if unanswered.",
    },
}
 
# Canonical subject names so PHYSICS / Physics / physics all collapse to one key.
_SUBJECT_ALIASES = {
    "physics": "Physics",
    "chemistry": "Chemistry",
    "maths": "Mathematics", "math": "Mathematics", "mathematics": "Mathematics",
    "biology": "Biology", "bio": "Biology",
    "botany": "Botany",
    "zoology": "Zoology",
}
 
 
def normalise_subject(raw):
    """'PHYSICS ' -> 'Physics'. Unknown labels are title-cased and kept as-is."""
    if not raw:
        return "General"
    key = re.sub(r"[^a-z]", "", raw.strip().lower())
    return _SUBJECT_ALIASES.get(key, raw.strip().title() or "General")
 
 
# ==============================================================================
#  CUSTOM ERROR TYPE  ->  always produces a clean JSON body
# ==============================================================================
class ParseError(Exception):
    """Raised for any expected, user-facing failure (bad file, etc.)."""
    def __init__(self, code, message, detail="", status=400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail
        self.status = status
 
 
def error_payload(code, message, detail="", status=400):
    body = {
        "result": "error",
        "error_code": code,
        "error": message,          # short, friendly - frontend shows this
        "detail": detail,          # technical context for the dev console
    }
    return jsonify(body), status
 
 
# ==============================================================================
#  STEP 1  -  TURN AN UPLOAD INTO CLEAN HTML
# ==============================================================================
def extract_html(raw_bytes, filename=""):
    """
    Accepts the raw bytes of an upload and returns a usable HTML string.
 
    Handles:
      * .mht / .mhtml  -> MIME multipart archive; we pull out the text/html part.
      * .html / .htm   -> decoded directly.
    Detection is content-based, so a mislabelled extension still works.
    """
    if not raw_bytes:
        raise ParseError("EMPTY_FILE", "The uploaded file is empty.",
                          "0 bytes received.")
 
    head = raw_bytes[:600].lstrip()
    looks_like_mht = (
        filename.lower().endswith((".mht", ".mhtml"))
        or head.startswith(b"From:")
        or b"multipart/related" in raw_bytes[:2000]
        or b"Snapshot-Content-Location" in raw_bytes[:2000]
    )
 
    if looks_like_mht:
        try:
            msg = email.message_from_bytes(raw_bytes, policy=policy.default)
        except Exception as e:
            raise ParseError("MHT_PARSE_FAILED",
                              "We could not read this .mht archive.",
                              f"email module error: {e}")
        html_parts = []
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                try:
                    payload = part.get_payload(decode=True) or b""
                    html_parts.append(payload.decode("utf-8", errors="ignore"))
                except Exception:
                    continue
        if not html_parts:
            raise ParseError("MHT_NO_HTML",
                              "This .mht file contains no readable web page.",
                              "No text/html part inside the MIME archive.")
        # Prefer the part that actually contains question markup; else the biggest.
        for h in html_parts:
            if "tblObjection" in h or "menu-tbl" in h:
                return h
        return max(html_parts, key=len)
 
    # Plain HTML - try a couple of encodings before giving up.
    for enc in ("utf-8", "utf-16", "latin-1"):
        try:
            return raw_bytes.decode(enc)
        except Exception:
            continue
    return raw_bytes.decode("utf-8", errors="ignore")
 
 
def make_soup(html):
    """Parse with lxml when available, fall back to the stdlib parser."""
    try:
        return BeautifulSoup(html, "lxml")
    except Exception:
        return BeautifulSoup(html, "html.parser")
 
 
# ==============================================================================
#  STEP 2  -  DETECT WHICH EXAM THIS SHEET BELONGS TO
# ==============================================================================
def detect_exam_type(soup):
    """Return 'MHT-CET', 'NEET' or None based on structural fingerprints."""
    if soup.find("table", id="tblObjection"):
        return "MHT-CET"
 
    text = soup.get_text(" ", strip=True).lower()
 
    # MHT-CET objection sheet fingerprints.
    if "candidate response" in text and "correct option" in text:
        return "MHT-CET"
    if "mhexam" in text or "mht-cet" in text or "mht cet" in text:
        return "MHT-CET"
 
    # NTA / NEET fingerprints.
    if soup.find("table", class_=re.compile(r"menu-tbl", re.I)):
        return "NEET"
    if "chosen option" in text and "question id" in text:
        return "NEET"
    if "national testing agency" in text or "neet" in text:
        return "NEET"
    return None
 
 
# ==============================================================================
#  STEP 3a  -  MHT-CET PARSER
# ==============================================================================
def parse_mhtcet(soup):
    """
    Parse an MHT-CET Objection-Tracker response sheet.
 
    The sheet structure:
        <table id="tblObjection"><tbody>
            <tr> ...header... </tr>
            <tr><td>QID</td><td>SECTION</td><td> ...question...
                    <div class="BoxNumber">opt1 id</div> x4
                    <table class="...center">
                        <span>Correct Option id</span>
                        <span>Candidate Response id</span>
                    </table>
            </td><td>Raise Objection</td></tr>
            ...
        </tbody></table>
 
    Because the correct option lives inside the sheet itself, scoring is exact
    and works for ANY shift / year with no answer-key file.
    """
    table = soup.find("table", id="tblObjection")
    rows = []
    if table:
        body = table.find("tbody") or table
        rows = body.find_all("tr", recursive=False)
    if not rows:
        # Fallback: any table whose header row mentions Question ID + Section.
        for t in soup.find_all("table"):
            head = t.get_text(" ", strip=True).lower()
            if "question id" in head and "section" in head:
                body = t.find("tbody") or t
                rows = body.find_all("tr", recursive=False)
                if rows:
                    break
    if not rows:
        raise ParseError(
            "MHTCET_NO_QUESTIONS",
            "We could not find any MHT-CET questions in this file.",
            "No <table id='tblObjection'> or equivalent question table found.")
 
    questions = []
    UNANSWERED = {"", "-", "--", "---", "na", "n/a", "not answered",
                  "not attempted", "none"}
 
    for row in rows:
        cells = row.find_all("td", recursive=False)
        if len(cells) < 3:                  # header row / spacer -> skip
            continue
 
        q_id = cells[0].get_text(strip=True)
        section = normalise_subject(cells[1].get_text(strip=True))
        body_cell = cells[2]
 
        # The four option IDs, in display order (option 1..4).
        option_ids = [d.get_text(strip=True)
                      for d in body_cell.find_all("div", class_="BoxNumber")]
 
        # The inner result table holds Correct Option + Candidate Response.
        inner = body_cell.find("table", class_=re.compile(r"center", re.I))
        spans = inner.find_all("span") if inner else []
        if len(spans) < 2:
            # Not a real question row (could be a layout artefact) - skip safely.
            continue
 
        correct_raw = spans[0].get_text(strip=True)
        chosen_raw = spans[1].get_text(strip=True)
 
        # Map an option ID back to a human-friendly 1-4 index when possible.
        def to_index(val):
            if val in option_ids:
                return option_ids.index(val) + 1
            return None
 
        cancelled = correct_raw.lower() in UNANSWERED or "cancel" in correct_raw.lower()
        attempted = chosen_raw.lower() not in UNANSWERED
 
        if cancelled:
            status = "cancelled"      # grace marks - treated as correct below
        elif not attempted:
            status = "unanswered"
        elif chosen_raw == correct_raw:
            status = "correct"
        else:
            status = "incorrect"
 
        questions.append({
            "question_id": q_id or f"Q{len(questions) + 1}",
            "subject": section,
            "chosen_index": to_index(chosen_raw),
            "correct_index": to_index(correct_raw),
            "status": status,
        })
 
    if not questions:
        raise ParseError(
            "MHTCET_EMPTY",
            "No valid MHT-CET questions could be read from this sheet.",
            "Question table was present but contained 0 parseable rows.")
    return questions
 
 
# ==============================================================================
#  STEP 3b  -  NEET (NTA) PARSER
# ==============================================================================
def load_neet_answer_key():
    """
    NEET response sheets from the NTA do NOT contain the correct answer, so an
    external key is required for exact scoring. Drop a file named
    `neet_answer_key.json` next to this script:
 
        { "questionId": "correctOptionId",  ...  }      # option ID, OR
        { "questionId": 3, ... }                        # 1-based option number
 
    If the file is absent we still parse the sheet and report attempt counts,
    but total_score is returned as null with a clear warning.
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "neet_answer_key.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {str(k): str(v).strip() for k, v in data.items()}
    except Exception as e:
        log.warning("Could not read neet_answer_key.json: %s", e)
        return None
 
 
def parse_neet(soup):
    """
    Parse an NTA NEET response sheet (the `menu-tbl` per-question format).
 
    Each question is a <table class="menu-tbl"> with label/value rows such as
    'Question ID', 'Option 1 ID' .. 'Option 4 ID', 'Status', 'Chosen Option'.
    The subject is taken from the nearest preceding section heading.
    """
    blocks = soup.find_all("table", class_=re.compile(r"menu-tbl", re.I))
    if not blocks:
        raise ParseError(
            "NEET_NO_QUESTIONS",
            "We could not find any NEET questions in this file.",
            "No <table class='menu-tbl'> blocks found - is this an NTA sheet?")
 
    answer_key = load_neet_answer_key()
    questions = []
    warnings = []
    UNANSWERED = {"", "-", "--", "not answered", "not attempted",
                  "marked for review", "0"}
 
    for block in blocks:
        # Build a {label: value} dict from the two-column rows.
        fields = {}
        for tr in block.find_all("tr"):
            tds = tr.find_all("td")
            if len(tds) >= 2:
                key = re.sub(r"[^a-z0-9]", "",
                             tds[0].get_text(strip=True).lower())
                fields[key] = tds[1].get_text(strip=True)
 
        q_id = fields.get("questionid") or fields.get("questionid:")
        if not q_id:
            continue
 
        option_ids = [fields.get(f"option{n}id", "") for n in range(1, 5)]
        chosen = (fields.get("chosenoption") or "").strip()
        status_txt = (fields.get("status") or "").lower()
 
        attempted = (chosen.lower() not in UNANSWERED
                     and "not answered" not in status_txt)
 
        # Subject = nearest preceding heading containing a known subject word.
        subject = "General"
        node = block
        for _ in range(40):
            node = node.find_previous(string=re.compile(
                r"physics|chemistry|botany|zoology|biology", re.I))
            if node:
                subject = normalise_subject(str(node))
                break
 
        status = "unanswered"
        if attempted:
            if answer_key is not None:
                correct = answer_key.get(str(q_id))
                if correct is None:
                    status = "no_key"          # attempted but key missing
                else:
                    # The key may store an option ID or a 1-4 number.
                    chosen_norm = chosen
                    if chosen in ("1", "2", "3", "4"):
                        idx = int(chosen) - 1
                        chosen_norm = option_ids[idx] if idx < len(option_ids) \
                            else chosen
                    status = "correct" if (chosen == correct or
                                           chosen_norm == correct) \
                        else "incorrect"
            else:
                status = "no_key"
 
        questions.append({
            "question_id": str(q_id),
            "subject": subject,
            "chosen_index": int(chosen) if chosen in ("1", "2", "3", "4") else None,
            "correct_index": None,
            "status": status,
        })
 
    if not questions:
        raise ParseError(
            "NEET_EMPTY",
            "No valid NEET questions could be read from this sheet.",
            "menu-tbl blocks were present but none contained a Question ID.")
 
    if answer_key is None:
        warnings.append(
            "No neet_answer_key.json found - showing attempt counts only. "
            "Add the NTA answer key file to compute an exact NEET score.")
    elif any(q["status"] == "no_key" for q in questions):
        missing = sum(1 for q in questions if q["status"] == "no_key")
        warnings.append(
            f"{missing} attempted question(s) are missing from the answer key "
            "and were excluded from the score.")
    return questions, warnings
 
 
# ==============================================================================
#  STEP 4  -  SCORING
# ==============================================================================
def score_questions(questions, exam_type):
    """
    Turn a flat list of parsed questions into a per-subject breakdown plus
    overall totals, applying the exam's marking scheme.
    """
    cfg = EXAM_CONFIG[exam_type]
    neg = cfg["negative"]
 
    breakdown = {}
    for q in questions:
        subj = q["subject"]
        b = breakdown.setdefault(subj, {
            "questions": 0, "attempted": 0, "correct": 0,
            "incorrect": 0, "unanswered": 0, "score": 0.0,
            "weight": cfg["weights"].get(subj, cfg["default_weight"]),
        })
        b["questions"] += 1
        w = b["weight"]
        st = q["status"]
 
        if st == "correct" or st == "cancelled":
            b["attempted"] += 1 if st == "correct" else 0
            b["correct"] += 1
            b["score"] += w
        elif st == "incorrect":
            b["attempted"] += 1
            b["incorrect"] += 1
            b["score"] -= neg
        elif st == "unanswered":
            b["unanswered"] += 1
        elif st == "no_key":            # attempted, correctness unknown
            b["attempted"] += 1
 
    # Tidy numbers: integers stay integers, add per-subject max.
    for b in breakdown.values():
        b["max"] = b["questions"] * b["weight"]
        b["score"] = int(b["score"]) if float(b["score"]).is_integer() \
            else round(b["score"], 2)
 
    total_q = sum(b["questions"] for b in breakdown.values())
    total_correct = sum(b["correct"] for b in breakdown.values())
    total_incorrect = sum(b["incorrect"] for b in breakdown.values())
    total_unanswered = sum(b["unanswered"] for b in breakdown.values())
    total_attempted = sum(b["attempted"] for b in breakdown.values())
    total_score = sum(b["score"] for b in breakdown.values())
    max_score = sum(b["max"] for b in breakdown.values())
 
    has_no_key = any(q["status"] == "no_key" for q in questions)
    accuracy = round(100 * total_correct / total_attempted, 1) \
        if total_attempted else 0.0
 
    return {
        "breakdown": breakdown,
        "total_questions": total_q,
        "attempted": total_attempted,
        "correct": total_correct,
        "incorrect": total_incorrect,
        "unanswered": total_unanswered,
        "total_score": None if has_no_key else (
            int(total_score) if float(total_score).is_integer()
            else round(total_score, 2)),
        "max_score": max_score,
        "accuracy": accuracy,
        "marking_scheme": cfg["scheme"],
    }
 
 
# ==============================================================================
#  STEP 5  -  ADVICE  (Gemini when available, deterministic fallback otherwise)
# ==============================================================================
def rule_based_advice(result, exam_type, category):
    """A solid, deterministic analysis used whenever the AI is unavailable."""
    bd = result["breakdown"]
    score = result["total_score"]
    mx = result["max_score"]
 
    if score is None:
        return ("Your response sheet was parsed successfully, but a NEET score "
                "needs the official NTA answer key. Add neet_answer_key.json to "
                "the backend folder to unlock exact marks and college predictions.")
 
    ranked = sorted(bd.items(),
                    key=lambda kv: kv[1]["correct"] / max(kv[1]["questions"], 1))
    weakest = ranked[0][0] if ranked else "—"
    strongest = ranked[-1][0] if ranked else "—"
    pct = round(100 * score / mx, 1) if mx else 0
 
    if exam_type == "MHT-CET":
        if pct >= 90:
            tier = ("an elite range - COEP, VJTI and PICT CSE are realistically "
                    "in reach for the " + category + " category")
        elif pct >= 78:
            tier = ("a strong range - core branches at VJTI/SPIT and most "
                    "branches at PICT are competitive")
        elif pct >= 60:
            tier = ("a mid range - target solid branches at PICT, VIT Pune and "
                    "Cummins rather than the top CSE seats")
        else:
            tier = ("a range where good tier-2 colleges and CAP round strategy "
                    "matter more than chasing the marquee institutes")
    else:
        if pct >= 85:
            tier = "a competitive NEET range for government MBBS counselling"
        elif pct >= 65:
            tier = "a range where state-quota and private MBBS/BDS seats are realistic"
        else:
            tier = "a range where category counselling strategy is decisive"
 
    return (f"You scored {score}/{mx} ({pct}%), which puts you in {tier}. "
            f"Your strongest subject is {strongest} and {weakest} is dragging "
            f"the total down - that is where focused revision converts fastest "
            f"into rank. Treat this estimate as a planning baseline and confirm "
            f"against this year's official cutoffs before locking preferences.")
 
 
def generate_advice(result, exam_type, category):
    """Try Gemini; on ANY failure fall back to the rule-based analysis."""
    if _ai_client is None:
        return rule_based_advice(result, exam_type, category), False
 
    bd = result["breakdown"]
    subj_lines = "\n".join(
        f"  {s}: {b['correct']}/{b['questions']} correct, score {b['score']}/{b['max']}"
        for s, b in bd.items())
    prompt = f"""You are a blunt, expert {exam_type} admissions counsellor.
Write ONE concise paragraph (3-4 sentences, no markdown, no lists) of brutally
honest, strategic advice for this student.
 
Score: {result['total_score']}/{result['max_score']}
Category: {category}
Accuracy: {result['accuracy']}%
Subject-wise:
{subj_lines}
 
Explicitly name their strongest and weakest subject. For MHT-CET reference real
institutes (COEP, VJTI, PICT, SPIT) appropriately to the score; for NEET talk in
terms of government vs private MBBS prospects. Be direct and realistic."""
    try:
        resp = _ai_client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(temperature=0.7,
                                               max_output_tokens=300),
        )
        text = (resp.text or "").strip()
        if not text:
            raise ValueError("empty response from model")
        return text, True
    except Exception as e:
        log.warning("Gemini advice failed (%s) - using fallback.", e)
        return rule_based_advice(result, exam_type, category), False
 
 
# ==============================================================================
#  DATABASE PATHS (Strictly Separated!)
# ==============================================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

CET_DB_PATH  = os.path.join(BASE_DIR, "MHTCET_Master.db")  
DB_PATH      = CET_DB_PATH   
USER_DB_PATH = os.path.join(BASE_DIR, "Users.db") # Cloud-safe path!


def db_status():
    """Quick health check for the SQLite database (used by /health + /predict)."""
    if not os.path.exists(CET_DB_PATH):
        return {"ok": False, "reason": "MHTCET_Master.db not found. "
                "Run py.py then add_colleges.py to build it."}
    try:
        conn = sqlite3.connect(CET_DB_PATH)
        cur = conn.cursor()
        tables = {r[0] for r in cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        out = {"ok": True, "tables": sorted(tables)}
        for t in ("cutoffs", "colleges"):
            if t in tables:
                out[f"{t}_rows"] = cur.execute(
                    f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        out["has_shift_stats"] = "shift_stats" in tables
        conn.close()
        if "cutoffs" not in tables or "colleges" not in tables:
            out["ok"] = False
            out["reason"] = "Database exists but is missing the "  \
                             "'cutoffs' or 'colleges' table."
        return out
    except Exception as e:
        return {"ok": False, "reason": f"DB open failed: {e}"}



# ==============================================================================
#  USER SAAS DATABASE & TOKEN ECONOMY
# ==============================================================================

def init_user_db():
    """Initializes the SaaS User Database and safely migrates new columns."""
    conn = sqlite3.connect(USER_DB_PATH)
    conn.execute('pragma journal_mode=wal')   # concurrent read+write
    cur = conn.cursor()

    # Core table — created fresh on first run
    cur.execute('''
        CREATE TABLE IF NOT EXISTS users (
            email           TEXT PRIMARY KEY,
            name            TEXT,
            picture         TEXT,
            is_pro          BOOLEAN  DEFAULT 0,
            tokens_left     INTEGER  DEFAULT 0,
            locked_marks    REAL     DEFAULT NULL,
            my_refer_code   TEXT     UNIQUE,
            referral_count  INTEGER  DEFAULT 0,
            referred_by     TEXT     DEFAULT NULL,
            reward_claimed  INTEGER  DEFAULT 0,
            created_at      TEXT     DEFAULT (datetime('now')),
            last_login      TEXT
        )
    ''')

    # FIX A10: Migration-safe — add new columns to existing DBs without error
    new_cols = [
        ("reward_claimed", "INTEGER DEFAULT 0"),
        ("created_at",     "TEXT DEFAULT (datetime('now'))"),
        ("last_login",     "TEXT"),
    ]
    existing = {row[1] for row in cur.execute("PRAGMA table_info(users)").fetchall()}
    for col, definition in new_cols:
        if col not in existing:
            cur.execute(f"ALTER TABLE users ADD COLUMN {col} {definition}")
            log.info("DB migration: added column '%s'", col)

    conn.commit()
    conn.close()

# Run once at startup
init_user_db()

def generate_referral_code(name):
    """Generates a unique 6-character code based on the user's name (e.g., ADI9X2)"""
    prefix = re.sub(r'[^A-Z]', '', str(name).upper())[:3]
    if len(prefix) < 3: prefix = (prefix + "GMC")[:3]
    suffix = ''.join(random.choices(string.ascii_uppercase + string.digits, k=3))
    return f"{prefix}{suffix}"

# --- Endpoint 1: Google Login Sync ---
@app.route("/sync-user", methods=["POST", "OPTIONS"])
def sync_user():
    if request.method == "OPTIONS": return ("", 204)
    
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    name = data.get("name", "Student")
    picture = data.get("picture", "")
    
    if not email:
        return jsonify({"result": "error", "error": "Email required"}), 400

    conn = sqlite3.connect(USER_DB_PATH)  # Use USER DB!
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    user = cur.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    
    if not user:
        refer_code = generate_referral_code(name)
        while cur.execute("SELECT 1 FROM users WHERE my_refer_code = ?", (refer_code,)).fetchone():
            refer_code = generate_referral_code(name)
            
        cur.execute('''
            INSERT INTO users (email, name, picture, my_refer_code) 
            VALUES (?, ?, ?, ?)
        ''', (email, name, picture, refer_code))
        conn.commit()
        user = cur.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    else:
        # Update picture + last_login on every sign-in
        cur.execute(
            "UPDATE users SET picture = ?, last_login = datetime('now') WHERE email = ?",
            (picture, email)
        )
        conn.commit()
        user = cur.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()

    conn.close()
    
    return jsonify({
        "result": "success",
        "user": {
            "email": user["email"],
            "name": user["name"],
            "is_pro": bool(user["is_pro"]),
            "tokens_left": user["tokens_left"],
            "locked_marks": user["locked_marks"],
            "my_refer_code": user["my_refer_code"],
            "referral_count": user["referral_count"],
            "reward_claimed": user["reward_claimed"] if "reward_claimed" in user.keys() else 0,
            "created_at": user["created_at"] if "created_at" in user.keys() else None,
        }
    })

# --- Endpoint: Get Fresh User State (called on page load / after payment) ---
@app.route("/get-user", methods=["GET", "OPTIONS"])
def get_user():
    """Lightweight state refresh — frontend calls this on every page load."""
    if request.method == "OPTIONS": return ("", 204)
    email = request.args.get("email", "").strip()
    if not email:
        return jsonify({"result": "error", "error": "Email required"}), 400

    conn = sqlite3.connect(USER_DB_PATH)
    conn.row_factory = sqlite3.Row
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()

    if not user:
        return jsonify({"result": "error", "error": "User not found"}), 404

    return jsonify({
        "result": "success",
        "user": {
            "email": user["email"],
            "name": user["name"],
            "picture": user["picture"],
            "is_pro": bool(user["is_pro"]),
            "tokens_left": user["tokens_left"],
            "locked_marks": user["locked_marks"],
            "my_refer_code": user["my_refer_code"],
            "referral_count": user["referral_count"],
            "reward_claimed": user["reward_claimed"] if "reward_claimed" in user.keys() else 0,
            "created_at": user["created_at"] if "created_at" in user.keys() else None,
        }
    })

# --- Endpoint 2: Use a Token & Lock Marks ---
@app.route("/use-token", methods=["POST", "OPTIONS"])
def use_token():
    if request.method == "OPTIONS": return ("", 204)
    
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    current_marks = float(data.get("marks", 0))
    
    if not email: return jsonify({"allowed": False, "reason": "NOT_LOGGED_IN", "tokens_left": 0})

    conn = sqlite3.connect(USER_DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    user = cur.execute("SELECT is_pro, tokens_left, locked_marks FROM users WHERE email = ?", (email,)).fetchone()
    
    if not user or not user["is_pro"]:
        conn.close()
        return jsonify({"allowed": False, "reason": "NOT_PRO", "tokens_left": 0})
        
    tokens_left  = user["tokens_left"]
    locked_marks = user["locked_marks"]
    
    if tokens_left <= 0:
        if locked_marks is not None and round(current_marks, 2) != round(float(locked_marks), 2):
            conn.close()
            return jsonify({
                "allowed": False, 
                "reason": "TOKENS_EMPTY", 
                "tokens_left": 0,
                "locked_marks": locked_marks,
                "message": "Your marks are locked. Top up tokens to change them."
            })
        # Same marks — allow re-filtering without burning a token
        conn.close()
        return jsonify({
            "allowed": True,
            "tokens_left": 0,
            "warning": "MARKS_LOCKED",
            "message": "Showing results for your locked marks. Top up to change them."
        })

    new_tokens = tokens_left - 1
    new_locked  = round(current_marks, 2) if new_tokens == 0 else locked_marks
    
    cur.execute("UPDATE users SET tokens_left = ?, locked_marks = ? WHERE email = ?",
                (new_tokens, new_locked, email))
    conn.commit()
    conn.close()
    
    return jsonify({"allowed": True, "tokens_left": new_tokens})


def _do_grant_pro(email: str, promo_code: str, is_topup: bool = False):
    """
    Internal helper — upgrades the user to PRO and rewards the referrer.
    Called only AFTER payment signature is verified.
    """
    conn = sqlite3.connect(USER_DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    if is_topup:
        # Top-up: add 3 more tokens, keep existing PRO, clear locked marks
        cur.execute(
            "UPDATE users SET tokens_left = tokens_left + 3, locked_marks = NULL WHERE email = ?",
            (email,)
        )
    else:
        # Fresh purchase: grant PRO, reset tokens to 3, clear locked marks
        cur.execute(
            "UPDATE users SET is_pro = 1, tokens_left = 3, locked_marks = NULL WHERE email = ?",
            (email,)
        )

    # Reward the referrer (only on fresh purchase, not top-up)
    if promo_code and not is_topup:
        user = cur.execute("SELECT referred_by FROM users WHERE email = ?", (email,)).fetchone()
        if user and not user["referred_by"]:
            cur.execute("UPDATE users SET referred_by = ? WHERE email = ?", (promo_code, email))
            cur.execute(
                "UPDATE users SET referral_count = referral_count + 1 WHERE my_refer_code = ?",
                (promo_code,)
            )

    conn.commit()
    conn.close()


# --- SECURE: Verify Razorpay Signature → THEN Grant PRO ---
@app.route("/verify-and-grant", methods=["POST", "OPTIONS"])
def verify_and_grant():
    """
    FIX A2: Called by premium.html after Razorpay payment success.
    Verifies the HMAC-SHA256 signature before granting PRO.
    Payload: { razorpay_payment_id, razorpay_order_id, razorpay_signature,
               email, promo_code }
    """
    if request.method == "OPTIONS": return ("", 204)
    data = request.get_json(silent=True) or {}

    payment_id  = data.get("razorpay_payment_id", "")
    order_id    = data.get("razorpay_order_id", "")
    signature   = data.get("razorpay_signature", "")
    email       = data.get("email", "").strip()
    promo_code  = data.get("promo_code", "").strip().upper()

    if not all([payment_id, order_id, signature, email]):
        return jsonify({"result": "error", "error": "Missing required fields."}), 400

    # --- Razorpay HMAC-SHA256 verification ---
    message = f"{order_id}|{payment_id}".encode("utf-8")
    expected = hmac.new(
        RZP_KEY_SECRET.encode("utf-8"),
        message,
        hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(expected, signature):
        log.warning("⚠️  SIGNATURE MISMATCH for email=%s  order=%s", email, order_id)
        return jsonify({"result": "error", "error": "Payment verification failed."}), 403

    # --- Signature valid → determine if this is a top-up ---
    conn = sqlite3.connect(USER_DB_PATH)
    conn.row_factory = sqlite3.Row
    user = conn.execute("SELECT is_pro FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()

    is_topup = bool(user and user["is_pro"])   # already PRO = this is a top-up

    _do_grant_pro(email, promo_code, is_topup)
    log.info("✅  PRO granted  email=%s  topup=%s  promo=%s", email, is_topup, promo_code or "—")
    return jsonify({"result": "success", "is_topup": is_topup})


# --- DEPRECATED: /grant-pro (kept so old JS doesn't 404, but refuses all grants) ---
# --- Endpoint: Grant Pro & Reward Referrer (SECURED) ---
@app.route("/grant-pro", methods=["POST", "OPTIONS"])
def grant_pro():
    if request.method == "OPTIONS": return ("", 204)
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    promo_code = data.get("promo_code", "").strip().upper()
    
    # 🚨 RED TEAM FIX: Verify Razorpay Signatures so hackers can't spoof payments
    payment_id = data.get("razorpay_payment_id")
    order_id = data.get("razorpay_order_id")
    signature = data.get("razorpay_signature")
    
    if not all([payment_id, order_id, signature]):
        return jsonify({"result": "error", "error": "Missing payment signatures."}), 400
        
    try:
        razorpay_client.utility.verify_payment_signature({
            'razorpay_order_id': order_id,
            'razorpay_payment_id': payment_id,
            'razorpay_signature': signature
        })
    except Exception as e:
        log.error(f"HACK ATTEMPT BLOCKED for {email}: Invalid Signature.")
        return jsonify({"result": "error", "error": "Invalid Signature. Hack attempt blocked."}), 400

    # --- Proceed to grant PRO ---
    conn = sqlite3.connect(USER_DB_PATH)
    cur = conn.cursor()
    
    # Give the buyer PRO, reset tokens to 3, and wipe locked marks
    cur.execute("UPDATE users SET is_pro = 1, tokens_left = 3, locked_marks = NULL WHERE email = ?", (email,))
    
    # If a promo code was used, reward the referrer!
    if promo_code:
        user = cur.execute("SELECT referred_by FROM users WHERE email = ?", (email,)).fetchone()
        if user and not user[0]: # If they haven't used a code before
            cur.execute("UPDATE users SET referred_by = ? WHERE email = ?", (promo_code, email))
            cur.execute("UPDATE users SET referral_count = referral_count + 1 WHERE my_refer_code = ?", (promo_code,))
    
    conn.commit()
    conn.close()
    return jsonify({"result": "success"})
# --- Category mapping -------------------------------------------------------
# Maps the user's (caste) selection to a reservation "relaxation" in percentile
# points relative to the General-Open (GOPEN) cut-off. These are realistic
# MHT-CET averages; when category-specific columns exist in the DB they are
# preferred, otherwise this offset approximates the reserved cut-off.
CATEGORY_RELAXATION = {
    "OPEN":            0.0,
    "EWS":             1.5,
    "TFWS":           -1.0,    
    "OBC":             3.0,
    "SEBC":            3.5,
    "VJ":              6.0,
    "NT1":             6.5,
    "NT2":             6.0,
    "NT3":             5.5,
    "SC":              9.0,
    "ST":             14.0,
    "JAIN_MINORITY":   0.0,  
    "RELIGIOUS_MINORITY":  0.0,
    "LINGUISTIC_MINORITY":  0.0,
    "OTHER_MINORITY":  0.0,
    "PWD":             8.0,
    "DEFENCE":         5.0,
    # --- RED TEAM FIX: Prevent Sub-Categories from defaulting to OPEN ---
    "GUJARATI_LINGUISTIC": 0.0,
    "HINDI_LINGUISTIC": 0.0,
    "SINDHI_LINGUISTIC": 0.0,
    "URDU_LINGUISTIC": 0.0,
    "TELUGU_LINGUISTIC": 0.0,
    "KANNADA_LINGUISTIC": 0.0,
    "CHRISTIAN_MINORITY": 0.0,
    "SIKH_MINORITY": 0.0,
    "PARSI_MINORITY": 0.0,
    "BUDDHIST_MINORITY": 0.0,
    "MUSLIM_MINORITY": 0.0,
}

# Friendly label -> internal key (frontend may send either).
CATEGORY_ALIASES = {
    "general": "OPEN", "open": "OPEN",
    "ews": "EWS", "tfws": "TFWS",
    "obc": "OBC", "sebc": "SEBC",
    "vj": "VJ", "vjnt": "VJ", "dtvj": "VJ",
    "nt1": "NT1", "nt-b": "NT1", "ntb": "NT1",
    "nt2": "NT2", "nt-c": "NT2", "ntc": "NT2",
    "nt3": "NT3", "nt-d": "NT3", "ntd": "NT3",
    "sc": "SC", "st": "ST",
    "jain": "JAIN_MINORITY", "jain minority": "JAIN_MINORITY",
    "religious": "RELIGIOUS_MINORITY", "religious minority": "RELIGIOUS_MINORITY",     # <-- ADDED
    "linguistic": "LINGUISTIC_MINORITY", "linguistic minority": "LINGUISTIC_MINORITY", # <-- ADDED
    "minority": "OTHER_MINORITY", "other minority": "OTHER_MINORITY",
    "pwd": "PWD", "defence": "DEFENCE", "defense": "DEFENCE",
}


def normalise_category(raw):
    if not raw:
        return "OPEN"
    key = str(raw).strip().lower()
    return CATEGORY_ALIASES.get(key, raw.strip().upper()
                                if raw.strip().upper() in CATEGORY_RELAXATION
                                else "OPEN")


# --- Branch mapping ---------------------------------------------------------
BRANCH_WILDCARDS = {
    "CSE":   "%Computer%",
    "CE":    "%Computer%",
    "IT":    "%Information%",
    "AIDS":  "%Artificial%",
    "AIML":  "%Machine Learning%",
    "DS":    "%Data Science%",
    "ENTC":  "%Electronics and Telecommunication%",
    "ECE":   "%Electronics%",
    "EE":    "%Electrical%",
    "ME":    "%Mechanical%",
    "CIVIL": "%Civil%",
    "CHEM":  "%Chemical%",
    "ROBO":  "%Robotics%",
}


# --- Shift normalisation ----------------------------------------------------
def load_shift_stats(conn):
    """
    Returns {shift_id: mean_percentile} from the optional 'shift_stats' table.
    If the table is absent we return {} and normalisation becomes a no-op.
    """
    try:
        cur = conn.cursor()
        rows = cur.execute(
            "SELECT Shift, Mean_Percentile FROM shift_stats").fetchall()
        return {str(r[0]).strip().upper(): float(r[1]) for r in rows if r[1]}
    except Exception:
        return {}


def normalise_percentile(raw_pct, shift, shift_stats):
    """
    Shift-difficulty correction. A student in a HARD shift (low mean percentile)
    gets a small upward correction so they compare fairly against cut-offs that
    were themselves set in a mix of shifts.

        difficulty_index = global_mean - shift_mean      (hard shift -> +ve)
        normalised       = raw + difficulty_index * 0.5  (capped at +/-1.5)
    """
    if not shift_stats or not shift:
        return raw_pct, 0.0
    shift_key = str(shift).strip().upper()
    if shift_key not in shift_stats:
        return raw_pct, 0.0
    global_mean = sum(shift_stats.values()) / len(shift_stats)
    diff = global_mean - shift_stats[shift_key]
    correction = max(-1.5, min(1.5, diff * 0.5))
    return round(min(100.0, raw_pct + correction), 4), round(correction, 3)


# --- Trend projection -------------------------------------------------------
def project_cutoff(year_cutoffs):
    """
    year_cutoffs: {year(int): percentile(float)} for a single choice code.
    Applies a weighted moving average that favours recent years, then projects
    one year forward using the recent delta (velocity).
    Returns (projected_cutoff, trend_label, latest_known).
    """
    if not year_cutoffs:
        return None, "unknown", None

    years = sorted(year_cutoffs.keys())
    latest = year_cutoffs[years[-1]]

    if len(years) == 1:
        return latest, "flat", latest

    # Velocity = average year-on-year change, recent change weighted higher.
    deltas = []
    for i in range(1, len(years)):
        gap = years[i] - years[i - 1]
        if gap > 0:
            deltas.append((year_cutoffs[years[i]] - year_cutoffs[years[i - 1]])
                           / gap)
    if not deltas:
        return latest, "flat", latest

    # weight recent deltas more (linear weights 1,2,3,...)
    w = list(range(1, len(deltas) + 1))
    velocity = sum(d * wi for d, wi in zip(deltas, w)) / sum(w)
    velocity = max(-2.0, min(2.0, velocity))     # clamp wild swings

    projected = round(min(100.0, latest + velocity), 3)
    if velocity > 0.15:
        trend = "rising"
    elif velocity < -0.15:
        trend = "falling"
    else:
        trend = "stable"
    return projected, trend, latest


# --- Risk + confidence ------------------------------------------------------
def risk_and_confidence(student_pct, projected_cutoff):
    """
    margin = student_pct - projected_cutoff
    Returns (risk_label, chance_percent 0-100).
    chance_percent uses a logistic curve centred on the cut-off.
    """
    margin = student_pct - projected_cutoff
    # logistic: steepness k tuned so +1.5 margin ~= 92%, -1.5 ~= 8%
    chance = 100.0 / (1.0 + math.exp(-1.6 * margin))
    chance = round(max(1.0, min(99.0, chance)), 1)

    if margin >= 1.0:
        risk = "Safe"
    elif margin >= -0.5:
        risk = "Moderate"
    elif margin >= -2.5:
        risk = "Reach"
    else:
        risk = "Unlikely"
    return risk, chance


def percentile_from_rank(rank):
    """Rough rank->percentile fallback (MHT-CET ~4.5 lakh candidates)."""
    try:
        rank = float(rank)
    except Exception:
        return None
    total = 450000.0
    if rank <= 0:
        return None
    pct = 100.0 * (1.0 - (rank / total))
    return round(max(1.0, min(99.999, pct)), 4)


def run_prediction(user):
    """
    Core predictor. `user` is a dict from the frontend form.
    Returns (matches list, meta dict).  Raises ParseError on bad input / no DB.
    """
    status = db_status()
    if not status["ok"]:
        raise ParseError("DB_UNAVAILABLE",
                          "The college database is not ready yet.",
                          status.get("reason", "unknown"), status=503)

    # ---- resolve the student's effective percentile ------------------------
    percentile = user.get("percentile")
    rank = user.get("rank")
    try:
        percentile = float(percentile) if percentile not in (None, "") else None
    except Exception:
        percentile = None
    if percentile is None and rank not in (None, ""):
        percentile = percentile_from_rank(rank)
    if percentile is None:
        raise ParseError("NO_SCORE",
                          "Please enter your percentile or your rank.",
                          "Neither percentile nor rank supplied.")
    percentile = max(0.0, min(100.0, percentile))

    category = normalise_category(user.get("category") or user.get("caste"))
    relaxation = CATEGORY_RELAXATION.get(category, 0.0)
    branch_pref = (user.get("branch") or "").strip().upper()
    shift = (user.get("shift") or "").strip()
    region = (user.get("location") or user.get("region") or "").strip()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # ---- shift normalisation ----------------------------------------------
    shift_stats = load_shift_stats(conn)
    norm_pct, shift_corr = normalise_percentile(percentile, shift, shift_stats)

    # "effective" percentile the reserved student competes with on OPEN seats
    effective_pct = min(99.99, norm_pct + relaxation)

    # ---- pull every choice code with its multi-year cut-off history --------
    # We look for branches whose latest cut-off is within reach (effective+2.5).
    sql = """
        SELECT c.Choice_Code, c.Institute_Name, c.Course_Name, c.Intake,
               c.Institute_Code, c.Minority_Status,
               t.Year, t.Round, t.Percentile, t.Seat_Type
        FROM colleges c
        JOIN cutoffs  t ON c.Choice_Code = t.Choice_Code
    """
    params = []
    if branch_pref and branch_pref not in ("ALL", "OTHER", ""):
        sql += " WHERE c.Course_Name LIKE ?"
        params.append(BRANCH_WILDCARDS.get(branch_pref, f"%{branch_pref}%"))
    rows = cur.execute(sql, params).fetchall()
    conn.close()

    # ---- group by choice code, keep best (lowest) cut-off per year ---------
    grouped = {}
    for r in rows:
        cc = r["Choice_Code"]
        g = grouped.setdefault(cc, {
            "info": {
                "college": r["Institute_Name"],
                "branch": r["Course_Name"],
                "intake": r["Intake"],
                "inst_code": r["Institute_Code"],
                "minority": r["Minority_Status"],
            },
            "years": {},
        })
        try:
            yr = int(re.search(r"20\d\d", str(r["Year"])).group())
        except Exception:
            continue
        pct = float(r["Percentile"])
        # keep the representative (highest open) cut-off per year
        if yr not in g["years"] or pct > g["years"][yr]:
            g["years"][yr] = pct

    # ---- score every branch ------------------------------------------------
    # ---- score every branch ------------------------------------------------
    matches = []
    for cc, g in grouped.items():
        projected, trend, latest = project_cutoff(g["years"])
        if projected is None:
            continue

        minority_status_db = str(g["info"]["minority"] or "NA").upper()
        minority_branch = minority_status_db not in ("NA", "", "NONE", "NULL")

        # ---- THE DYNAMIC MINORITY ENGINE ----
        adjusted_projected = projected
        user_cat = category.upper()

        if minority_branch:
            # 1. Jain Minority (Massive cutoff drop for Jain students in Jain colleges like SNJB)
            if "JAIN" in user_cat and "JAIN" in minority_status_db:
                adjusted_projected = max(1.0, projected - 75.0) 
            
            # 2. Linguistic Minority (Gujarati / Hindi / Sindhi)
            elif "LINGUISTIC" in user_cat and any(k in minority_status_db for k in ["LINGUISTIC", "HINDI", "GUJARATI", "SINDHI"]):
                adjusted_projected = max(1.0, projected - 50.0)
            
            # 3. Religious Minority
            elif "RELIGIOUS" in user_cat and "RELIGIOUS" in minority_status_db:
                adjusted_projected = max(1.0, projected - 40.0)
            
            # 4. Generic Minority Fallback
            elif "MINORITY" in user_cat and "MINORITY" in minority_status_db:
                adjusted_projected = max(1.0, projected - 40.0)

        # Risk profiling uses the strictly adjusted minority cutoff!
        risk, chance = risk_and_confidence(effective_pct, adjusted_projected)
        
        if risk == "Unlikely":
            continue            # >2.5 percentile short - not worth listing

        # location nudge: properly check comma-separated cities
        regions = [r.strip().lower() for r in region.split(",") if r.strip()]
        loc_match = False
        if regions:
            college_name_lower = g["info"]["college"].lower()
            loc_match = any(r in college_name_lower for r in regions)
            
        if loc_match:
            chance = min(99.0, chance + 3.0)

        matches.append({
            "choice_code": cc,
            "college": g["info"]["college"],
            "branch": g["info"]["branch"],
            "intake": g["info"]["intake"],
            "inst_code": g["info"]["inst_code"],
            "minority": g["info"]["minority"],
            "cutoff": round(adjusted_projected, 2), # Display the real minority cutoff!
            "cutoff_latest": round(latest, 2) if latest else None,
            "history": {str(y): round(v, 2)
                        for y, v in sorted(g["years"].items())},
            "trend": trend,
            "risk": risk,
            "chance": chance,
            "location_match": loc_match,
            "minority_branch": minority_branch,
        })
    # default sort: best chance first, then higher cut-off (better college)
    matches.sort(key=lambda m: (-m["chance"], -m["cutoff"]))

    meta = {
        "raw_percentile": round(percentile, 3),
        "normalised_percentile": round(norm_pct, 3),
        "shift_correction": shift_corr,
        "category": category,
        "category_relaxation": relaxation,
        "effective_percentile": round(effective_pct, 3),
        "shift": shift or None,
        "branch_pref": branch_pref or "ALL",
        "total_matches": len(matches),
        "buckets": {
            "Safe": sum(1 for m in matches if m["risk"] == "Safe"),
            "Moderate": sum(1 for m in matches if m["risk"] == "Moderate"),
            "Reach": sum(1 for m in matches if m["risk"] == "Reach"),
        },
        "shift_stats_used": bool(shift_stats),
    }
    return matches, meta


# --- Direct Gemini HTTP caller (gemini-2.5-pro, JSON-capable) ---------------
def _call_gemini(prompt, model="gemini-2.5-pro", max_tokens=8192,
                 temperature=0.7, json_mode=False, timeout=60):
    """
    Calls the Gemini REST API directly via urllib. Returns text or None.

    IMPORTANT: gemini-2.5-pro is a THINKING model -- it spends output tokens on
    internal reasoning. max_tokens must be generous (>=4096) or the model
    returns EMPTY text with finishReason=MAX_TOKENS.
    """
    if not GEMINI_KEY:
        log.error("=" * 64)
        log.error(" GEMINI KEY IS EMPTY -- paste your key into GEMINI_KEY (top of file).")
        log.error("=" * 64)
        return None

    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model}:generateContent?key={GEMINI_KEY}")

    gen_cfg = {"temperature": temperature, "maxOutputTokens": max_tokens}
    if json_mode:
        gen_cfg["responseMimeType"] = "application/json"

    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": gen_cfg,
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            url, data=body,
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="ignore")
        log.error("=" * 64)
        log.error(" GEMINI HTTP %s  (model=%s)", e.code, model)
        log.error(" %s", err[:600])
        if "API key not valid" in err:
            log.error(" >> Your API KEY IS INVALID. Get a new one at "
                      "https://aistudio.google.com/app/apikey")
        elif e.code == 403:
            log.error(" >> 403: enable the 'Generative Language API' for this key.")
        elif e.code == 404:
            log.error(" >> 404: model not found. Try model='gemini-2.5-flash'.")
        elif e.code == 429:
            log.error(" >> 429: quota / rate limit hit. Wait, or upgrade the plan.")
        log.error("=" * 64)
        return None
    except Exception as e:
        log.error(" GEMINI network error: %s: %s", type(e).__name__, e)
        return None

    try:
        cand = (data.get("candidates") or [{}])[0]
        finish = cand.get("finishReason", "?")
        parts = (cand.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts).strip()
        if not text:
            log.error(" GEMINI returned EMPTY text. finishReason=%s", finish)
            if finish == "MAX_TOKENS":
                log.error(" >> Model spent all tokens thinking. Raise max_tokens.")
            log.error(" Raw response: %s", json.dumps(data)[:500])
            return None
        log.info(" GEMINI (%s) replied OK -- %d chars.", model, len(text))
        return text
    except Exception as e:
        log.error(" GEMINI parse error: %s | raw: %s", e, json.dumps(data)[:500])
        return None


def gemini_selftest():
    """Pings Gemini once at startup; prints a clear PASS/FAIL line."""
    if not GEMINI_KEY:
        log.warning(" No Gemini key -- AI features will use the rule-based fallback.")
        return
    log.info(" Running Gemini self-test (gemini-2.5-pro)...")
    out = _call_gemini("Reply with exactly one word: PONG",
                       model="gemini-2.5-pro", max_tokens=2048, temperature=0)
    if out and "PONG" in out.upper():
        log.info(" ==> GEMINI IS WORKING.")
    else:
        log.error(" ==> GEMINI SELF-TEST FAILED -- read the error lines above.")


# --- Gemini placement summaries (JSON, gemini-2.5-pro) ----------------------
def gemini_placement_summaries(top_colleges):
    """Returns [{college,branch,avg_package,top_recruiters,summary}, ...]."""
    fallback = [{
        "college": c["college"], "branch": c["branch"],
        "avg_package": "N/A", "top_recruiters": [],
        "summary": ("Gemini call failed -- check the Python terminal for the "
                    "exact error line."),
    } for c in top_colleges]

    if not GEMINI_KEY or not top_colleges:
        return fallback

    listing = "\n".join(f"{i+1}. {c['college']} - {c['branch']}"
                        for i, c in enumerate(top_colleges))
    prompt = (
        "You are a strict Maharashtra engineering placement analyst. For each "
        "college+branch below, give a realistic placement snapshot.\n\n"
        f"{listing}\n\n"
        "Return ONLY a JSON array. Each item must have keys: "
        '"college", "branch", "avg_package" (e.g. "6-9 LPA"), '
        '"top_recruiters" (array of 3 company strings), '
        '"summary" (one honest sentence). '
        "CRITICAL: If you do not have exact data for a specific college, give a realistic estimate based on its tier and add '(Est.)' to the avg_package."
    )

    text = _call_gemini(prompt, model="gemini-2.5-pro",
                        max_tokens=8192, temperature=0.3, json_mode=True)
    if not text:
        return fallback
    try:
        clean = re.sub(r"^```(?:json)?|```$", "", text.strip(),
                       flags=re.I | re.M).strip()
        parsed = json.loads(clean)
        if isinstance(parsed, list) and parsed:
            log.info(" Placement JSON parsed: %d items.", len(parsed))
            return parsed
    except Exception as e:
        log.error(" Placement JSON parse failed: %s | raw: %s", e, text[:300])
    return fallback


def gemini_strategy_advice(meta, matches):
    """Returns (advice_text, ai_was_used_bool)."""
    buckets = meta["buckets"]
    top = ", ".join(m["college"] for m in matches[:3]) or "no strong matches"
    rule = (f"At {meta['effective_percentile']}%ile effective merit "
            f"({meta['category']} category) you have {buckets['Safe']} safe, "
            f"{buckets['Moderate']} moderate and {buckets['Reach']} reach "
            f"options. Lock safe colleges early; keep reach picks to the "
            f"top 1-3 slots.")

    if not GEMINI_KEY:
        return rule, False

    prompt = (
        "You are a blunt MHT-CET CAP-round counsellor.\n"
        f"Student: raw {meta['raw_percentile']}%ile, "
        f"shift-corrected {meta['normalised_percentile']}%ile, "
        f"category {meta['category']}, effective {meta['effective_percentile']}%ile.\n"
        f"Safe/Moderate/Reach: {buckets}. Top matches: {top}.\n"
        "Write 3-4 honest sentences: is the branch expectation realistic, how "
        "to order the CAP form, and whether rising cutoff trends help or hurt "
        "next round. No markdown, no lists, no pleasantries."
    )
    text = _call_gemini(prompt, model="gemini-2.5-flash",
                        max_tokens=4096, temperature=0.7)
    return (text or rule), bool(text)


# ==============================================================================
#  ROUTES
# ==============================================================================
@app.route("/", methods=["GET"])
def home():
    return jsonify({
        "service": "Guess My College - Score Engine",
        "version": "2.0",
        "status": "online",
        "supported_exams": list(EXAM_CONFIG.keys()),
        "endpoints": ["/calculate-score", "/predict-college",
                      "/create-payment-order", "/create-pro-order",
                      "/health"],
    })
 
 
@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "ai_advice": "gemini" if _ai_client else "rule-based-fallback",
        "payments": "enabled" if _razorpay_client else "disabled",
        "database": db_status(),
    })
 
def predict_percentile_gemini(score, max_score, exam_type, category):
    """Uses Gemini 2.5 Flash to predict a percentile range based on score and category."""
    if not GEMINI_KEY:
        return "N/A"
    
    prompt = (
        f"You are an expert {exam_type} admissions data analyst. "
        f"A student from the {category} category just scored {score} out of {max_score}. "
        "Based on historical data and category cutoffs, predict their expected percentile as a tight range. "
        "Respond ONLY with the numbers and '%ile' (e.g., '94.5 - 95.5 %ile'). Do not write any other text."
    )
    
    # Switched to Flash and bumped max_tokens to prevent the crash!
    text = _call_gemini(prompt, model="gemini-2.5-flash", max_tokens=256, temperature=0.2)
    return text.strip() if text else "Calculate Failed"


def gemini_selftest():
    """Pings Gemini once at startup; prints a clear PASS/FAIL line."""
    if not GEMINI_KEY:
        log.warning(" No Gemini key -- AI features will use the rule-based fallback.")
        return
    log.info(" Running Gemini self-test (gemini-2.5-flash)...")
    
    # Switched to Flash for reliability
    out = _call_gemini("Reply with exactly one word: PONG", model="gemini-2.5-flash", max_tokens=100, temperature=0)
    
    if out:
        log.info(" ==> GEMINI IS WORKING. Reply: %s", out)
    else:
        log.error(" ==> GEMINI SELF-TEST FAILED -- read the error lines above.")

        
@app.route("/calculate-score", methods=["POST", "OPTIONS"])
def calculate_score():
    if request.method == "OPTIONS":
        return ("", 204)
 
    try:
        # ---- 1. validate the upload ------------------------------------------
        if "file" not in request.files:
            raise ParseError("NO_FILE", "No file was uploaded.",
                              "request.files has no 'file' key.")
        file = request.files["file"]
        if not file or file.filename == "":
            raise ParseError("EMPTY_FILENAME", "Please choose a file first.",
                              "Filename was empty.")
 
        category = (request.form.get("category") or "OPEN").strip()
        # exam can be forced from the UI; otherwise we auto-detect.
        forced_exam = (request.form.get("exam") or "AUTO").strip().upper()
 
        raw = file.read()
        log.info("Received '%s' (%d bytes, exam=%s, category=%s)",
                 file.filename, len(raw), forced_exam, category)
 
        # ---- 2. upload -> html ----------------------------------------------
        html = extract_html(raw, file.filename)
        soup = make_soup(html)
 
        # ---- 3. decide the exam type ----------------------------------------
        exam_type = detect_exam_type(soup)
        if forced_exam in EXAM_CONFIG:
            exam_type = forced_exam
        if exam_type is None:
            raise ParseError(
                "UNKNOWN_FORMAT",
                "We could not recognise this file as an MHT-CET or NEET "
                "response sheet. Please upload the correct .html / .mht sheet.",
                "No MHT-CET or NEET structural fingerprint matched.")
 
        # ---- 4. parse + score -----------------------------------------------
        warnings = []
        if exam_type == "MHT-CET":
            questions = parse_mhtcet(soup)
        else:
            questions, warnings = parse_neet(soup)
 
        result = score_questions(questions, exam_type)
 
        if result["total_questions"] == 0:
            raise ParseError(
                "NO_QUESTIONS",
                "No questions could be read from this response sheet.",
                "Parser returned an empty question set.")
 
        # ---- 5. advice & percentile ------------------------------------------
        advice, ai_used = generate_advice(result, exam_type, category)
        
        # NEW: Call Gemini Pro for the percentile prediction
        predicted_pct = predict_percentile_gemini(
            result["total_score"], 
            result["max_score"], 
            exam_type, 
            category
        )
 
        log.info("Scored %s: %s/%s across %d questions",
                 exam_type, result["total_score"], result["max_score"],
                 result["total_questions"])
 
        return jsonify({
            "result": "success",
            "exam_type": exam_type,
            "category": category,
            **result,
            "ai_advice": advice,
            "ai_source": "gemini" if ai_used else "rule-based",
            "predicted_percentile": predicted_pct,  # NEW: Send to frontend
            "warnings": warnings,
        })
 
    except ParseError as e:
        log.warning("ParseError [%s]: %s", e.code, e.detail or e.message)
        return error_payload(e.code, e.message, e.detail, e.status)
 
    except Exception as e:                              # truly unexpected
        log.error("Unhandled error:\n%s", traceback.format_exc())
        return error_payload(
            "SERVER_ERROR",
            "Something went wrong while processing your sheet. Please try again.",
            f"{type(e).__name__}: {e}",
            status=500)
    
@app.route("/predict-college", methods=["POST", "OPTIONS"])
def predict_college():
    if request.method == "OPTIONS": return ("", 204)
    
    # 1. GATEKEEPER: Check Login & Rate Limits first
    client_ip = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()
    if not _check_rate_limit(client_ip):
        return jsonify({"result": "error", "error": "Too many requests. Wait a moment."}), 429

    try:
        data = request.get_json(silent=True) or {}
        email = data.get('email')
        # Check against percentile OR marks for the lock comparison
        current_score = float(data.get('percentile') or data.get('marks') or 0)
        
        # Security: Force Login
        if not email:
            return jsonify({"result": "error", "error": "Unauthorized. Please login."}), 401
            
        # Security: Check Pro & Tokens
        conn = sqlite3.connect(USER_DB_PATH)
        user = conn.cursor().execute("SELECT is_pro, tokens_left, locked_marks FROM users WHERE email = ?", (email,)).fetchone()
        conn.close()
        
        if not user or not user[0]: # is_pro
            return jsonify({"result": "error", "error": "PRO Account Required."}), 403
            
        # If no tokens left, verify the marks are locked
        if user[1] <= 0: 
            if user[2] is not None and round(current_score, 2) != round(float(user[2]), 2):
                return jsonify({"result": "error", "error": "Tokens empty. Marks locked to previous value."}), 403

        # 2. CORE PREDICTION ENGINE
        # legacy support: if only marks supplied, estimate a percentile
        if not data.get("percentile") and not data.get("rank") and data.get("marks"):
            m = float(data.get("marks", 0))
            data["percentile"] = (99.9 if m > 180 else 98.5 if m > 150 else 96.0 if m > 130
                                  else 90.0 if m > 100 else 80.0 if m > 80 else 60.0 + m * 0.2)

        matches, meta = run_prediction(data)

        # ---- Sort -----------------------------------------------------------
        sort = (data.get("sort") or "chance").lower()
        if sort == "rank": matches.sort(key=lambda x: -x["cutoff"])
        elif sort == "cutoff": matches.sort(key=lambda x: x["cutoff"])
        else: matches.sort(key=lambda x: (-x["chance"], -x["cutoff"]))

        # ---- AI layer -------------------------------------------------------
        advice = "Compare multiple categories and branches seamlessly."
        ai_used = False
        placements = []

        if data.get("want_advice", True):
            advice, ai_used = gemini_strategy_advice(meta, matches)
            
        if data.get("want_placement", True):
            placements = gemini_placement_summaries(matches[:3])

        return jsonify({
            "result": "success",
            "meta": meta,
            "matches": matches,
            "placements": placements,
            "ai_advice": advice,
            "ai_source": "gemini" if ai_used else "rule-based",
        })

    except ParseError as e:
        log.warning("Predict ParseError [%s]: %s", e.code, e.detail)
        return error_payload(e.code, e.message, e.detail, e.status)
    except Exception as err:
        log.error("Predict crashed:\n%s", traceback.format_exc())
        return error_payload("PREDICT_FAILED", "Unexpected error.", f"{type(err).__name__}: {err}", status=500)
# --------------------------------------------------------- payment routes -----
@app.route("/create-payment-order", methods=["POST", "OPTIONS"])
def create_payment_order():
    if request.method == "OPTIONS":
        return ("", 204)
    return _make_order(amount_rupees=899, receipt="booking_001")
 
 # --- Endpoint: Validate Referral Promo Code ---
@app.route("/validate-promo", methods=["POST", "OPTIONS"])
def validate_promo():
    if request.method == "OPTIONS": return ("", 204)
    data = request.get_json(silent=True) or {}
    code = data.get("promo_code", "").strip().upper()
    email = data.get("email", "")

    conn = sqlite3.connect(USER_DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Check if the promo code belongs to a real user
    referrer = cur.execute("SELECT email FROM users WHERE my_refer_code = ?", (code,)).fetchone()
    
    if not referrer:
        conn.close()
        return jsonify({"valid": False, "message": "Invalid Referral Code."})
        
    # Prevent users from using their own code
    if referrer["email"] == email:
        conn.close()
        return jsonify({"valid": False, "message": "You cannot use your own referral code!"})

    # Prevent users from using multiple codes
    user = cur.execute("SELECT referred_by FROM users WHERE email = ?", (email,)).fetchone()
    if user and user["referred_by"]:
        conn.close()
        return jsonify({"valid": False, "message": "You have already used a referral code before."})

    conn.close()
    return jsonify({"valid": True, "discount_pct": 20, "message": "🎉 20% OFF Applied!"})

# --- Endpoint: Dynamic Razorpay Order ---
@app.route('/create-pro-order', methods=['POST', 'OPTIONS'])
def create_pro_order():
    """
    FIX A1: Fixed `razorpay_client` → `_razorpay_client` (was crashing every payment).
    FIX A5: is_topup is now determined by checking the DB, not trusting localStorage.
             A user is a top-up if they are already PRO in the database.
    """
    if request.method == "OPTIONS": return ("", 204)

    if _razorpay_client is None:
        return error_payload("PAYMENTS_DISABLED",
                             "Online payments are temporarily unavailable.",
                             "razorpay not initialised.", status=503)

    data = request.get_json(silent=True) or {}
    email      = data.get("email", "").strip()
    promo_code = data.get("promo_code", "").strip().upper()

    # FIX A5: Determine is_topup from DB, not from client-supplied flag
    is_topup = False
    if email:
        conn = sqlite3.connect(USER_DB_PATH)
        conn.row_factory = sqlite3.Row
        user = conn.execute("SELECT is_pro FROM users WHERE email = ?", (email,)).fetchone()
        conn.close()
        is_topup = bool(user and user["is_pro"])

    # Pricing logic (server-controlled)
    if is_topup:
        amount = 179 * 100   # ₹179 — 40% off, no promo stacking
    elif promo_code:
        conn = sqlite3.connect(USER_DB_PATH)
        referrer = conn.execute(
            "SELECT 1 FROM users WHERE my_refer_code = ?", (promo_code,)
        ).fetchone()
        conn.close()
        amount = (int(299 * 0.80) * 100) if referrer else (299 * 100)
    else:
        amount = 299 * 100   # ₹299 base price

    try:
        order = _razorpay_client.order.create(data={   # FIX A1
            "amount": amount, "currency": "INR", "receipt": "gmc_pro_order"
        })
        return jsonify({
            "result": "success",
            "order_id": order["id"],
            "amount": amount,
            "is_topup": is_topup,
            "key_id": RZP_KEY_ID
        })
    except Exception as e:
        log.error("Razorpay create-pro-order failed: %s", e)
        return jsonify({"result": "error", "error": str(e)}), 502
 
def _make_order(amount_rupees, receipt):
    if _razorpay_client is None:
        return error_payload(
            "PAYMENTS_DISABLED",
            "Online payments are temporarily unavailable.",
            "razorpay package not installed or client not initialised.",
            status=503)
    try:
        amount = amount_rupees * 100        # paise
        order = _razorpay_client.order.create(data={
            "amount": amount, "currency": "INR", "receipt": receipt,
        })
        return jsonify({"result": "success",
                        "order_id": order["id"],
                        "amount": amount,
                        "key_id": RZP_KEY_ID})
    except Exception as e:
        log.error("Razorpay order failed: %s", e)
        return error_payload("PAYMENT_FAILED",
                             "Could not start the payment. Please try again.",
                             str(e), status=502)
 
 

# --- Admin: Basic Stats Dashboard (password-protected) ---
ADMIN_PASSWORD = os.environ.get("GMC_ADMIN_PASSWORD", "parth@gmc2025")

@app.route("/admin/stats", methods=["GET", "OPTIONS"])
def admin_stats():
    """
    Quick admin overview. Pass ?password=your_password in query string.
    Move this behind proper auth before production!
    """
    if request.method == "OPTIONS": return ("", 204)
    if request.args.get("password", "") != ADMIN_PASSWORD:
        return jsonify({"result": "error", "error": "Unauthorized"}), 401

    conn = sqlite3.connect(USER_DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    total_users    = cur.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    pro_users      = cur.execute("SELECT COUNT(*) FROM users WHERE is_pro = 1").fetchone()[0]
    total_referrals= cur.execute("SELECT SUM(referral_count) FROM users").fetchone()[0] or 0
    new_today      = cur.execute(
        "SELECT COUNT(*) FROM users WHERE DATE(created_at) = DATE('now')"
    ).fetchone()[0]
    recent         = cur.execute(
        "SELECT email, name, is_pro, tokens_left, referral_count, created_at "
        "FROM users ORDER BY created_at DESC LIMIT 20"
    ).fetchall()

    conn.close()
    return jsonify({
        "result": "success",
        "total_users": total_users,
        "pro_users": pro_users,
        "free_users": total_users - pro_users,
        "total_referrals_made": total_referrals,
        "new_signups_today": new_today,
        "recent_users": [dict(r) for r in recent]
    })


@app.errorhandler(413)
def too_large(_):
    return error_payload("FILE_TOO_LARGE",
                         "That file is too large (limit is 64 MB).",
                         "MAX_CONTENT_LENGTH exceeded.", status=413)
 
 
@app.errorhandler(404)
def not_found(_):
    return error_payload("NOT_FOUND", "That endpoint does not exist.",
                         "404", status=404)
 
 
if __name__ == "__main__":
    log.info("Score Engine v2 starting on http://127.0.0.1:5000")
    gemini_selftest()          # prints PASS/FAIL for Gemini at startup
    app.run(host="127.0.0.1", port=5000, debug=True)