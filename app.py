"""
Wealth Builder — Streamlit Web App
Run locally:  streamlit run app.py
Deploy free:  https://streamlit.io/cloud
"""

import streamlit as st
import json, os, hashlib, threading, re, sqlite3
from datetime import datetime
import urllib.request

# ══════════════════════════════════════════════════════════════════
#  PAGE CONFIG  (must be first streamlit call)
# ══════════════════════════════════════════════════════════════════
st.set_page_config(
    page_title="Wealth Builder",
    page_icon="💰",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# ══════════════════════════════════════════════════════════════════
#  STORAGE
# ══════════════════════════════════════════════════════════════════
APP_DIR    = os.path.join(os.path.expanduser("~"), ".wealth_builder_web")
USERS_FILE = os.path.join(APP_DIR, "users.json")
BOND_DB    = os.path.join(APP_DIR, "bond_rates.db")
os.makedirs(APP_DIR, exist_ok=True)

def _hash(pw): return hashlib.sha256(pw.encode()).hexdigest()
def _user_file(u):
    s = "".join(c for c in u.lower() if c.isalnum() or c in "-_")
    return os.path.join(APP_DIR, f"{s}_data.json")

def load_users():
    try:
        if os.path.exists(USERS_FILE):
            with open(USERS_FILE) as f: return json.load(f)
    except: pass
    return {}

def save_users(u):
    with open(USERS_FILE,"w") as f: json.dump(u,f,indent=2)

def load_data(u):
    try:
        p = _user_file(u)
        if os.path.exists(p):
            with open(p) as f: return json.load(f)
    except: pass
    return []

def save_data(u, entries):
    with open(_user_file(u),"w") as f: json.dump(entries,f,indent=2)

# ── Bond DB ───────────────────────────────────────────────────────
def _bond_db():
    conn = sqlite3.connect(BOND_DB)
    conn.execute("""CREATE TABLE IF NOT EXISTS bond_rates (
        month_str TEXT, year_str TEXT, tenor TEXT,
        rate REAL, source TEXT, fetched_at TEXT,
        PRIMARY KEY (month_str, year_str, tenor))""")
    return conn

def bond_db_get(month_str, year_str, tenor):
    try:
        conn = _bond_db()
        cur  = conn.execute(
            "SELECT rate,source,fetched_at FROM bond_rates "
            "WHERE month_str=? AND year_str=? AND tenor=?",
            (month_str, year_str, tenor))
        row = cur.fetchone(); conn.close(); return row
    except: return None

def bond_db_save(month_str, year_str, tenor, rate, source):
    try:
        conn = _bond_db()
        conn.execute(
            "INSERT OR REPLACE INTO bond_rates VALUES(?,?,?,?,?,?)",
            (month_str, year_str, tenor, rate, source,
             datetime.now().isoformat(timespec="seconds")))
        conn.commit(); conn.close()
    except: pass

def bond_db_all():
    try:
        conn = _bond_db()
        cur  = conn.execute(
            "SELECT month_str,year_str,tenor,rate,source,fetched_at "
            "FROM bond_rates")
        rows = cur.fetchall(); conn.close()
        mo   = {m:i for i,m in enumerate(MONTHS)}
        rows.sort(key=lambda r: (-int(r[1]), mo.get(r[0],99), r[2]))
        return rows
    except: return []

# ══════════════════════════════════════════════════════════════════
#  CONSTANTS
# ══════════════════════════════════════════════════════════════════
_cur_year = datetime.now().year
YEARS  = [str(y) for y in range(2026, max(2027, _cur_year+6))]
MONTHS = ["January","February","March","April","May","June",
          "July","August","September","October","November","December"]
MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun",
                "Jul","Aug","Sep","Oct","Nov","Dec"]

NGX_TICKERS = sorted(set("""
ABBEYBDS ABCTRANS ACADEMY ACCESSCORP AFRIPRUD AIICO AIRTELAFRI ARADEL ARBICO
AUSTINLAZ BAPLC BERGER BETAGLAS BUACEMENT BUAFOODS CADBURY CAP CAPHOTEL CAVERTON
CHAMPION CHAMS CHELLARAM CHIPLC CILEASING CONHALLPLC CONOIL CORNERST CUSTODIAN
CUTIX CWG DAARCOMM DANGCEM DANGSUGAR DEAPCAP EKOCORP ELLAHLAKES ENAMELWA ETERNA
ETI ETRANZACT EUNISELL FCMB FIDELITYBK FIDSON FIRSTHOLDCO FTNCOCOA GEREGU
GTCO GUINEAINS GUINNESS HMCALL HONYFLOUR IKEJAHOTEL IMG INFINITY INTBREW
JAIZBANK JAPAULGOLD JBERGER JOHNHOLT JULI LASACO LINKASSURE LIVESTOCK MANSARD
MAYBAKER MBENEFIT MCNICHOLS MECURE MEYER MORISON MTNN MULTIVERSE NAHCO NASCON
NB NCR NEIMETH NEM NESTLE NEWGOLD NGXGROUP NNFM NPFMCRFBK NSLTECH OANDO
OKOMUOIL OMATEK PHARMDEKO PREMPAINTS PRESCO PRESTIGE PZ REDSTAREX REGALINS
RONCHESS ROYALEX RTBRISCOE SCOA SEPLAT SKYAVN SOVRENINS STACO STANBIC
STERLINGNG SUNUASSUR TANTALIZER THOMASWY TIP TOTAL TRANSCOHOT TRANSCORP
TRANSEXPR TRANSPOWER TRIPPLEG UACN UBA UCAP UHOMREIT UNILEVER UNIONDICON
UNITYBNK UNIVINSURE UPDC UPL VERITASKAP VETBANK VETGOODS VFDGROUP VITAFOAM
WAPCO WAPIC WEMABANK ZENITHBANK ZICHIS
""".split()))

EQUITY_FUNDS = [
    "Stanbic IBTC Nigerian Equity Fund",
    "ARM Aggressive Growth Fund",
    "Coronation Equity Fund",
    "FBN Nigeria Smart Beta Equity Fund",
    "United Capital Equity Fund",
    "AXA Mansard Equity Income Fund",
    "Meristem Equity Market Fund",
    "Chapel Hill Denham Nigeria Equity Fund",
    "CardinalStone Equity Fund",
    "Vetiva Griffin 30 ETF",
    "GT Equity Income Fund",
]

def fmt(n): return f"₦{int(round(n)):,}"

# ══════════════════════════════════════════════════════════════════
#  NETWORK
# ══════════════════════════════════════════════════════════════════
_HDR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,*/*;q=0.8",
}

def _fetch_html(url, timeout=10):
    req = urllib.request.Request(url, headers=_HDR)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="ignore")

def fetch_bond_rate(tenor, month_str, year_str):
    cached = bond_db_get(month_str, year_str, tenor)
    if cached:
        return cached[0], "✓ Rate loaded"
    try:
        target_m = MONTHS.index(month_str)+1
        target_y = int(year_str)
    except: return None, "Invalid month/year."
    today = datetime.now()
    if (target_y, target_m) > (today.year, today.month):
        return None, f"{month_str} {year_str} rate not released yet."
    import urllib.parse as up
    candidate = None
    try:
        q   = up.quote(f"DMO {month_str} {year_str} FGN Savings Bond")
        res = json.loads(_fetch_html(
            f"https://nairametrics.com/wp-json/wp/v2/search?search={q}&per_page=10"))
        for item in res:
            lnk = item.get("url","")
            um  = re.search(r'nairametrics\.com/(\d{4})/(\d{2})/', lnk)
            if um and um.group(1)==year_str and int(um.group(2))==target_m:
                slug = lnk.rstrip("/").split("/")[-1].lower()
                if "savings-bond" in slug:
                    candidate=lnk; break
    except: pass
    if candidate:
        try:
            art  = _fetch_html(candidate, timeout=12)
            word = "two-year" if tenor=="2yr" else "three-year"
            dig  = "2-year"  if tenor=="2yr" else "3-year"
            tail = r'[^.]{0,160}?(\d{1,2}\.\d{2,3})\s*(?:%|per\s*cent)'
            for p in [word+tail, dig+tail]:
                m2 = re.search(p, art, re.IGNORECASE)
                if m2:
                    rate = float(m2.group(1))
                    if 5.0<=rate<=35.0:
                        bond_db_save(month_str,year_str,tenor,rate,"Nairametrics")
                        return rate,"✓ Rate loaded"
        except: pass
    return None, "Could not fetch rate. Try again or enter manually."

def fetch_stock_price(ticker):
    import ssl, http.cookiejar
    ctx = ssl.create_default_context()
    ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
    cj  = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cj),
        urllib.request.HTTPSHandler(context=ctx))
    opener.addheaders = list(_HDR.items())
    tl = ticker.strip().lower()
    tu = ticker.strip().upper()
    try:
        resp = opener.open("https://afx.kwayisi.org/ngx/", timeout=12)
        html = resp.read().decode("utf-8",errors="ignore")
        pat  = (r'href="/ngx/'+re.escape(tl)+r'[/"]?[^>]*>\s*'+
                re.escape(tu)+r'\s*<.*?<td[^>]*>([\d,]+\.?\d*)</td>')
        m = re.search(pat, html, re.IGNORECASE|re.DOTALL)
        if m:
            v=float(m.group(1).replace(",",""))
            if 0.01<v<1e6: return v,"NGX live"
    except: pass
    try:
        r2   = opener.open(f"https://afx.kwayisi.org/ngx/{tl}/", timeout=10)
        h2   = r2.read().decode("utf-8",errors="ignore")
        m3   = re.search(r'NGN\s*([\d,]+\.\d{2})', h2)
        if m3:
            v2=float(m3.group(1).replace(",",""))
            if 0.01<v2<1e6: return v2,"NGX live"
    except: pass
    return None, f"{tu} price unavailable. Enter cost manually."

# ══════════════════════════════════════════════════════════════════
#  STYLES  (Bold & Modern — purple/teal/amber)
# ══════════════════════════════════════════════════════════════════
def inject_css():
    st.markdown("""
    <style>
    /* ── Global ── */
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    html, body, [class*="css"] { font-family: 'Inter', sans-serif !important; }
    .main .block-container { padding: 0 !important; max-width: 100% !important; }
    header[data-testid="stHeader"] { display:none !important; }
    section[data-testid="stSidebar"] { display:none !important; }
    .stApp { background: #F0F2FF !important; }

    /* ── Top bar ── */
    .wb-topbar {
        background: linear-gradient(135deg, #6C63FF 0%, #A855F7 100%);
        padding: 14px 28px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        box-shadow: 0 2px 12px rgba(108,99,255,0.3);
    }
    .wb-logo {
        background: white;
        color: #6C63FF;
        font-weight: 800;
        font-size: 14px;
        width: 38px; height: 38px;
        border-radius: 10px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-right: 12px;
    }
    .wb-title { color: white; font-size: 18px; font-weight: 700; }
    .wb-sub   { color: rgba(255,255,255,0.75); font-size: 11px; }
    .wb-user-badge {
        background: rgba(255,255,255,0.15);
        color: white;
        padding: 6px 14px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 600;
    }

    /* ── Hero card ── */
    .wb-hero {
        background: linear-gradient(135deg, #6C63FF 0%, #A855F7 100%);
        border-radius: 16px;
        padding: 28px 32px 20px;
        margin: 20px 28px 8px;
        box-shadow: 0 8px 32px rgba(108,99,255,0.25);
        color: white;
    }
    .wb-hero-lbl  { font-size: 13px; opacity: 0.8; margin-bottom: 4px; }
    .wb-hero-val  { font-size: 36px; font-weight: 800; letter-spacing: -1px; }
    .wb-hero-sub  { font-size: 12px; opacity: 0.7; margin-top: 6px; }

    /* ── Metric chips ── */
    .wb-chips { display:flex; gap:10px; flex-wrap:wrap; margin:12px 28px 20px; }
    .wb-chip {
        padding: 8px 16px;
        border-radius: 20px;
        font-size: 13px;
        font-weight: 600;
    }
    .chip-total  { background:#EDE9FF; color:#6C63FF; }
    .chip-bond   { background:#D0F5EE; color:#00875A; }
    .chip-equity { background:#F3E8FF; color:#A855F7; }
    .chip-stock  { background:#FEF3CD; color:#B45309; }

    /* ── Section headers ── */
    .wb-section {
        margin: 0 28px 6px;
        padding: 14px 20px 6px;
        background: white;
        border-radius: 12px 12px 0 0;
        border-bottom: 2px solid #6C63FF;
    }
    .wb-section-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: #6C63FF;
    }

    /* ── Form wrapper ── */
    .wb-form-wrap {
        margin: 0 28px 20px;
        background: white;
        border-radius: 0 0 12px 12px;
        padding: 16px 20px 20px;
        box-shadow: 0 2px 12px rgba(0,0,0,0.06);
    }

    /* ── Log cards ── */
    .wb-log-wrap { margin: 0 28px 20px; }
    .wb-card {
        background: white;
        border-radius: 12px;
        padding: 14px 18px;
        margin-bottom: 10px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        border-left: 4px solid #6C63FF;
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
    }
    .wb-card.bond   { border-left-color: #00D4AA; }
    .wb-card.equity { border-left-color: #A855F7; }
    .wb-card.stock  { border-left-color: #F59E0B; }
    .wb-card-month  { font-weight: 700; font-size: 14px; color: #1A1A2E; }
    .wb-card-type   { font-size: 12px; color: #8892A4; margin-top: 3px; }
    .wb-card-detail { font-size: 12px; color: #8892A4; margin-top: 2px; }
    .wb-card-amount { font-size: 16px; font-weight: 700; text-align: right; }
    .wb-card-rate   { font-size: 12px; font-weight: 600; text-align: right; margin-top: 3px; }
    .wb-pl-pos { color: #00875A; }
    .wb-pl-neg { color: #991B1B; }

    /* ── Summary cards ── */
    .wb-summary-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin: 0 28px 28px;
    }
    .wb-sum-card {
        background: white;
        border-radius: 12px;
        padding: 16px 18px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
    .wb-sum-lbl { font-size: 11px; color: #8892A4; text-transform: uppercase;
                  letter-spacing:.5px; margin-bottom: 6px; }
    .wb-sum-val { font-size: 22px; font-weight: 800; }

    /* ── Buttons ── */
    .stButton > button {
        border-radius: 8px !important;
        font-weight: 600 !important;
        border: none !important;
        padding: 10px 20px !important;
    }
    .stButton > button:hover { opacity: 0.9; }

    /* ── Login page ── */
    .wb-login-hero {
        background: linear-gradient(135deg, #6C63FF 0%, #A855F7 100%);
        text-align: center;
        padding: 48px 24px 40px;
        color: white;
    }
    .wb-login-logo {
        background: white;
        color: #6C63FF;
        width: 64px; height: 64px;
        border-radius: 16px;
        font-size: 22px;
        font-weight: 800;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 16px;
    }
    .wb-login-title { font-size: 26px; font-weight: 800; }
    .wb-login-sub   { font-size: 13px; opacity: 0.8; margin-top: 6px; }
    .wb-login-badge {
        background: rgba(255,255,255,0.15);
        display: inline-block;
        padding: 5px 14px;
        border-radius: 20px;
        font-size: 12px;
        margin-top: 10px;
    }
    .wb-login-box {
        max-width: 420px;
        margin: 0 auto;
        padding: 32px 28px;
        background: white;
        border-radius: 0 0 16px 16px;
    }

    /* ── Streamlit overrides ── */
    .stTextInput > div > div > input {
        border-radius: 8px !important;
        border: 1.5px solid #E0DBFF !important;
        background: #F5F3FF !important;
        font-size: 14px !important;
        padding: 10px 14px !important;
    }
    .stTextInput > div > div > input:focus {
        border-color: #6C63FF !important;
        box-shadow: 0 0 0 3px rgba(108,99,255,0.15) !important;
    }
    .stSelectbox > div > div {
        border-radius: 8px !important;
        border: 1.5px solid #E0DBFF !important;
        background: #F5F3FF !important;
    }
    div[data-testid="stNumberInput"] input {
        border-radius: 8px !important;
        border: 1.5px solid #E0DBFF !important;
        background: #F5F3FF !important;
    }
    .stAlert { border-radius: 10px !important; }
    hr { border-color: #E0DBFF !important; margin: 16px 0 !important; }

    /* hide streamlit branding */
    #MainMenu, footer, .stDeployButton { display:none !important; }
    </style>
    """, unsafe_allow_html=True)

# ══════════════════════════════════════════════════════════════════
#  SESSION STATE INIT
# ══════════════════════════════════════════════════════════════════
def init_state():
    defaults = {
        "logged_in":    False,
        "username":     None,
        "entries":      [],
        "page":         "login",   # login | dashboard | log | settings
        "bond_rate":    None,
        "bond_status":  "",
        "stock_price":  None,
        "stock_status": "",
        "filter_year":  "All Years",
        "filter_month": "All Months",
    }
    for k,v in defaults.items():
        if k not in st.session_state:
            st.session_state[k] = v

init_state()

# ══════════════════════════════════════════════════════════════════
#  LOGIN PAGE
# ══════════════════════════════════════════════════════════════════
def login_page():
    inject_css()
    st.markdown("""
    <div class="wb-login-hero">
        <div class="wb-login-logo">WB</div>
        <div class="wb-login-title">Wealth Builder</div>
        <div class="wb-login-sub">Your personal investment tracker</div>
        <div class="wb-login-badge">🔒 Secure & Private</div>
    </div>
    """, unsafe_allow_html=True)

    col1, col2, col3 = st.columns([1, 2, 1])
    with col2:
        tab_login, tab_reg = st.tabs(["🔑 Login", "✨ Create Account"])

        with tab_login:
            st.markdown("<br>", unsafe_allow_html=True)
            username = st.text_input("Username", key="li_user",
                placeholder="Enter your username")
            password = st.text_input("Password", type="password",
                key="li_pass", placeholder="Enter your password")
            if st.button("🔑 Login to your account",
                    use_container_width=True, key="btn_login"):
                if not username:
                    st.error("Please enter a username.")
                elif not password:
                    st.error("Please enter a password.")
                else:
                    users = load_users()
                    ud    = users.get(username.lower())
                    if not ud or ud["password"] != _hash(password):
                        st.error("Incorrect username or password.")
                    else:
                        st.session_state.logged_in = True
                        st.session_state.username  = ud["display"]
                        st.session_state.entries   = load_data(ud["display"])
                        st.session_state.page      = "dashboard"
                        st.rerun()

        with tab_reg:
            st.markdown("<br>", unsafe_allow_html=True)
            new_user = st.text_input("Username", key="reg_user",
                placeholder="Choose a username")
            new_pass = st.text_input("Password", type="password",
                key="reg_pass", placeholder="Choose a password (min 4 chars)")
            new_cfm  = st.text_input("Confirm Password", type="password",
                key="reg_cfm", placeholder="Repeat your password")
            if st.button("✅ Create Account",
                    use_container_width=True, key="btn_reg"):
                if not new_user:
                    st.error("Please enter a username.")
                elif len(new_pass) < 4:
                    st.error("Password must be at least 4 characters.")
                elif new_pass != new_cfm:
                    st.error("Passwords do not match.")
                else:
                    users = load_users()
                    if new_user.lower() in users:
                        st.error("Username already taken.")
                    else:
                        users[new_user.lower()] = {
                            "display":  new_user,
                            "password": _hash(new_pass),
                            "email":    ""}
                        save_users(users)
                        st.session_state.logged_in = True
                        st.session_state.username  = new_user
                        st.session_state.entries   = []
                        st.session_state.page      = "dashboard"
                        st.rerun()

        st.markdown("""
        <p style='text-align:center;color:#8892A4;font-size:12px;margin-top:20px'>
        Your data is stored securely on the server</p>
        """, unsafe_allow_html=True)

# ══════════════════════════════════════════════════════════════════
#  TOPBAR
# ══════════════════════════════════════════════════════════════════
def topbar():
    username = st.session_state.username
    st.markdown(f"""
    <div class="wb-topbar">
        <div style="display:flex;align-items:center">
            <div class="wb-logo">WB</div>
            <div>
                <div class="wb-title">Wealth Builder</div>
                <div class="wb-sub">Personal Investment Tracker</div>
            </div>
        </div>
        <div class="wb-user-badge">👤 {username}</div>
    </div>
    """, unsafe_allow_html=True)

    c1,c2,c3,c4,c5 = st.columns([2,1,1,1,1])
    with c2:
        if st.button("🏠 Dashboard", use_container_width=True):
            st.session_state.page = "dashboard"; st.rerun()
    with c3:
        if st.button("➕ Log Entry", use_container_width=True):
            st.session_state.page = "log"; st.rerun()
    with c4:
        if st.button("⚙️ Settings", use_container_width=True):
            st.session_state.page = "settings"; st.rerun()
    with c5:
        if st.button("⏻ Logout", use_container_width=True):
            for k in list(st.session_state.keys()):
                del st.session_state[k]
            init_state()
            st.rerun()
    st.markdown("<div style='margin-bottom:4px'></div>",
        unsafe_allow_html=True)

# ══════════════════════════════════════════════════════════════════
#  DASHBOARD PAGE
# ══════════════════════════════════════════════════════════════════
def dashboard_page():
    entries = st.session_state.entries
    bt = sum(e["amount"] for e in entries if e.get("type") in ("bond","bond2"))
    et = sum(e["amount"] for e in entries if e.get("type") == "equity")
    st_ = sum(e["amount"] for e in entries if e.get("type") == "stock")
    total = bt + et + st_
    ml = len({(e.get("year",""),e.get("month","")) for e in entries})

    # Hero
    st.markdown(f"""
    <div class="wb-hero">
        <div class="wb-hero-lbl">Total Portfolio Value</div>
        <div class="wb-hero-val">{fmt(total)}</div>
        <div class="wb-hero-sub">{ml} month{'s' if ml!=1 else ''} logged  •  {len(entries)} entries</div>
    </div>
    """, unsafe_allow_html=True)

    # Chips
    st.markdown(f"""
    <div class="wb-chips">
        <span class="wb-chip chip-total">💼 Total: {fmt(total)}</span>
        <span class="wb-chip chip-bond">🏦 Bond: {fmt(bt)}</span>
        <span class="wb-chip chip-equity">📈 Equity: {fmt(et)}</span>
        <span class="wb-chip chip-stock">📊 Stocks: {fmt(st_)}</span>
    </div>
    """, unsafe_allow_html=True)

    # Quick log button
    col_a, col_b = st.columns([3,1])
    with col_a:
        pass
    with col_b:
        if st.button("➕ Log New Entry", use_container_width=True):
            st.session_state.page = "log"; st.rerun()

    st.markdown("---")

    # Monthly Log
    st.markdown("""
    <div style='margin:0 0 10px'>
        <span style='font-size:11px;font-weight:700;text-transform:uppercase;
        letter-spacing:1px;color:#6C63FF'>📋 Monthly Log</span>
    </div>
    """, unsafe_allow_html=True)

    # Filters
    fc1, fc2, fc3 = st.columns([1,1,2])
    with fc1:
        yr_opts = ["All Years"] + YEARS
        sel_yr  = st.selectbox("Year", yr_opts,
            index=yr_opts.index(st.session_state.filter_year)
                  if st.session_state.filter_year in yr_opts else 0,
            key="dash_yr")
        st.session_state.filter_year = sel_yr
    with fc2:
        mo_opts = ["All Months"] + MONTHS
        sel_mo  = st.selectbox("Month", mo_opts,
            index=mo_opts.index(st.session_state.filter_month)
                  if st.session_state.filter_month in mo_opts else 0,
            key="dash_mo")
        st.session_state.filter_month = sel_mo

    filtered = [e for e in entries
        if (sel_yr=="All Years"  or e.get("year","")==sel_yr)
        and(sel_mo=="All Months" or e.get("month","")==sel_mo)]

    def sort_key(e):
        try: yi = YEARS.index(e.get("year","2026"))
        except: yi = 99
        try: mi = MONTHS.index(e.get("month","January"))
        except: mi = 99
        return (yi, mi)

    filtered = sorted(filtered, key=sort_key)

    if not filtered:
        st.info("No entries for this period yet. Click **➕ Log New Entry** to add one!")
    else:
        tlbl = {"bond":"FGN Bond 3yr","bond2":"FGN Bond 2yr",
                "equity":"Equity Funds","stock":"Stocks"}
        tcls = {"bond":"bond","bond2":"bond",
                "equity":"equity","stock":"stock"}
        tcol = {"bond":"#00D4AA","bond2":"#00D4AA",
                "equity":"#A855F7","stock":"#F59E0B"}

        for i, e in enumerate(filtered):
            typ    = e.get("type","")
            month  = e.get("month","")
            year   = e.get("year","")
            amount = e.get("amount",0)
            cls    = tcls.get(typ,"")
            col    = tcol.get(typ,"#6C63FF")
            type_lbl = tlbl.get(typ, typ)

            detail = ""
            right_detail = ""
            if typ in ("bond","bond2") and e.get("rate"):
                detail = f"Rate: {e['rate']:.3f}% p.a."
                right_detail = f'<div class="wb-card-rate" style="color:{col}">{e["rate"]:.3f}% p.a.</div>'
            elif typ == "equity":
                fund  = e.get("fund","")
                units = e.get("units","")
                cost  = e.get("cost_per_unit",0)
                detail = f"{fund} · {units} units · Cost: {fmt(cost)}/unit" if fund else f"{units} units"
                right_detail = f'<div class="wb-card-rate" style="color:{col}">{units} units</div>'
            elif typ == "stock":
                ticker = e.get("ticker","")
                units  = e.get("units","")
                cost   = e.get("cost_price",0)
                live   = e.get("live_price")
                detail = f"{ticker} · {units} units · Cost: {fmt(cost)}/share"
                if live and cost and units:
                    try:
                        pl = (float(live)-float(cost))*float(units)
                        pl_cls = "wb-pl-pos" if pl>=0 else "wb-pl-neg"
                        pl_sign= "+" if pl>=0 else ""
                        right_detail = (
                            f'<div class="wb-card-rate" style="color:{col}">{units} units</div>'
                            f'<div class="wb-card-rate {pl_cls}">P/L: {pl_sign}{fmt(abs(pl))}</div>')
                    except: right_detail = f'<div class="wb-card-rate" style="color:{col}">{units} units</div>'
                else:
                    right_detail = f'<div class="wb-card-rate" style="color:{col}">{units} units</div>'

            col1, col2 = st.columns([10,1])
            with col1:
                st.markdown(f"""
                <div class="wb-card {cls}">
                    <div>
                        <div class="wb-card-month">{month} {year}</div>
                        <div class="wb-card-type">{type_lbl}</div>
                        <div class="wb-card-detail">{detail}</div>
                    </div>
                    <div>
                        <div class="wb-card-amount" style="color:{col}">{fmt(amount)}</div>
                        {right_detail}
                    </div>
                </div>
                """, unsafe_allow_html=True)
            with col2:
                if st.button("🗑️", key=f"del_{e['id']}_{i}",
                        help="Delete entry"):
                    st.session_state.entries = [
                        x for x in st.session_state.entries
                        if x["id"] != e["id"]]
                    save_data(st.session_state.username,
                              st.session_state.entries)
                    st.rerun()

    st.markdown("---")

    # Summary section
    st.markdown("""
    <div style='margin:0 0 10px'>
        <span style='font-size:11px;font-weight:700;text-transform:uppercase;
        letter-spacing:1px;color:#F59E0B'>⭐ Summary</span>
    </div>
    """, unsafe_allow_html=True)

    bp   = round((bt/total)*100) if total else 0
    lg   = max(entries, key=lambda e:e["amount"]) if entries else None
    avg  = total/ml if ml else 0

    sc1,sc2,sc3,sc4 = st.columns(4)
    for col_w, lbl, val, color in [
        (sc1, "Total Invested",   fmt(total),              "#6C63FF"),
        (sc2, "Monthly Average",  fmt(avg),                "#00875A"),
        (sc3, "Bond Allocation",  f"{bp}% bonds",          "#00D4AA"),
        (sc4, "Largest Entry",    fmt(lg["amount"]) if lg else "₦0", "#F59E0B"),
    ]:
        with col_w:
            st.markdown(f"""
            <div class="wb-sum-card">
                <div class="wb-sum-lbl">{lbl}</div>
                <div class="wb-sum-val" style="color:{color}">{val}</div>
            </div>
            """, unsafe_allow_html=True)

    # Progress bar
    st.markdown("<br>", unsafe_allow_html=True)
    st.caption(f"{ml} of 12 months logged")
    st.progress(min(ml/12, 1.0))

    # Chart
    st.markdown("---")
    st.markdown("""
    <div style='margin:0 0 10px'>
        <span style='font-size:11px;font-weight:700;text-transform:uppercase;
        letter-spacing:1px;color:#00875A'>📊 Growth Chart</span>
    </div>
    """, unsafe_allow_html=True)

    chart_data = {m: {"bond":0,"equity":0,"stock":0} for m in MONTHS_SHORT}
    for e in entries:
        ms = e.get("month","")
        if ms in MONTHS:
            idx = MONTHS.index(ms)
            mk  = MONTHS_SHORT[idx]
            t   = "bond" if e["type"] in ("bond","bond2") else e["type"]
            if t in chart_data[mk]:
                chart_data[mk][t] += e.get("amount",0)

    import pandas as pd
    df = pd.DataFrame([
        {"Month":m,
         "FGN Bond":chart_data[m]["bond"],
         "Equity":chart_data[m]["equity"],
         "Stocks":chart_data[m]["stock"]}
        for m in MONTHS_SHORT
    ]).set_index("Month")

    st.bar_chart(df, color=["#00D4AA","#A855F7","#F59E0B"],
                 height=280, use_container_width=True)

# ══════════════════════════════════════════════════════════════════
#  LOG ENTRY PAGE
# ══════════════════════════════════════════════════════════════════
def log_page():
    st.markdown("""
    <div style='margin:20px 0 14px'>
        <span style='font-size:11px;font-weight:700;text-transform:uppercase;
        letter-spacing:1px;color:#6C63FF'>✏️ Log Investment</span>
    </div>
    """, unsafe_allow_html=True)

    c1, c2 = st.columns(2)
    with c1:
        year = st.selectbox("Year *", [""] + YEARS, key="log_year")
    with c2:
        month = st.selectbox("Month *", [""] + MONTHS, key="log_month")

    inv_type = st.selectbox("Investment Type *",
        ["","FGN Bond (3yr)","FGN Bond (2yr)","Equity Funds","Stocks"],
        key="log_type")

    # Dynamic fields
    bond_rate  = None
    eq_fund    = None
    eq_units   = None
    eq_cost    = None
    st_ticker  = None
    st_units   = None
    st_cost    = None
    live_price = None

    if inv_type in ("FGN Bond (3yr)","FGN Bond (2yr)"):
        tenor = "3yr" if "3yr" in inv_type else "2yr"
        st.markdown("**Bond Rate % p.a.**")

        col_a, col_b = st.columns([3,1])
        with col_b:
            fetch_clicked = st.button("🔄 Fetch Rate", key="fetch_bond",
                use_container_width=True)

        if fetch_clicked:
            if not year or not month:
                st.warning("Please select Year and Month first.")
            else:
                with st.spinner("Searching..."):
                    rate, msg = fetch_bond_rate(tenor, month, year)
                st.session_state.bond_rate   = rate
                st.session_state.bond_status = msg

        with col_a:
            if st.session_state.bond_rate:
                st.success(f"✓ {st.session_state.bond_rate:.3f}% p.a.  —  {st.session_state.bond_status}")
                bond_rate = st.session_state.bond_rate
            elif st.session_state.bond_status:
                st.error(st.session_state.bond_status)

    elif inv_type == "Equity Funds":
        eq_fund  = st.selectbox("Equity Fund *", [""] + EQUITY_FUNDS,
            key="log_fund")
        ca, cb = st.columns(2)
        with ca: eq_units = st.number_input("Units Purchased *",
            min_value=0.0, step=1.0, key="log_eq_units")
        with cb: eq_cost  = st.number_input("Cost per Unit (₦) *",
            min_value=0.0, step=1.0, key="log_eq_cost")

    elif inv_type == "Stocks":
        st_ticker = st.selectbox("Stock Ticker *",
            [""] + list(NGX_TICKERS), key="log_ticker")

        col_price, col_fetch = st.columns([3,1])
        with col_fetch:
            fetch_stock = st.button("🔄 Fetch Price",
                key="fetch_stock", use_container_width=True)
        if fetch_stock:
            if not st_ticker:
                st.warning("Please select a ticker first.")
            else:
                with st.spinner("Searching..."):
                    price, msg = fetch_stock_price(st_ticker)
                st.session_state.stock_price  = price
                st.session_state.stock_status = msg
        with col_price:
            if st.session_state.stock_price:
                st.success(f"✓ {st_ticker}: {fmt(st.session_state.stock_price)}/share  —  {st.session_state.stock_status}")
                live_price = st.session_state.stock_price
            elif st.session_state.stock_status:
                st.warning(st.session_state.stock_status)

        sa, sb = st.columns(2)
        with sa: st_units = st.number_input("Units / Shares *",
            min_value=0.0, step=1.0, key="log_st_units")
        with sb:
            default_cost = float(st.session_state.stock_price) \
                if st.session_state.stock_price else 0.0
            st_cost = st.number_input("Cost per Share (₦) *",
                min_value=0.0, step=1.0,
                value=default_cost, key="log_st_cost")

    amount = st.number_input("Amount (₦) *", min_value=0.0,
        step=1000.0, key="log_amount")

    st.markdown("<br>", unsafe_allow_html=True)
    col_save, col_clear = st.columns([1,1])

    with col_save:
        if st.button("✅ Save Entry", use_container_width=True,
                key="btn_save"):
            errors = []
            if not year:   errors.append("Please select a year.")
            if not month:  errors.append("Please select a month.")
            if not inv_type: errors.append("Please select investment type.")
            if amount <= 0: errors.append("Please enter a valid amount.")

            entry = {
                "id":     int(datetime.now().timestamp()*1000),
                "year":   year, "month": month, "amount": amount,
            }

            if not errors:
                if inv_type in ("FGN Bond (3yr)","FGN Bond (2yr)"):
                    if not bond_rate and not st.session_state.bond_rate:
                        errors.append("Please fetch bond rate first.")
                    else:
                        entry["type"] = "bond" if "3yr" in inv_type else "bond2"
                        entry["rate"] = bond_rate or st.session_state.bond_rate

                elif inv_type == "Equity Funds":
                    if not eq_fund: errors.append("Please select an equity fund.")
                    if not eq_units: errors.append("Please enter units.")
                    if not eq_cost:  errors.append("Please enter cost per unit.")
                    if not errors:
                        entry["type"]         = "equity"
                        entry["fund"]         = eq_fund
                        entry["units"]        = eq_units
                        entry["cost_per_unit"]= eq_cost

                elif inv_type == "Stocks":
                    if not st_ticker: errors.append("Please select a ticker.")
                    if not st_units:  errors.append("Please enter units.")
                    if not st_cost:   errors.append("Please enter cost per share.")
                    if not errors:
                        entry["type"]       = "stock"
                        entry["ticker"]     = st_ticker
                        entry["units"]      = st_units
                        entry["cost_price"] = st_cost
                        entry["live_price"] = live_price or st.session_state.stock_price

            if errors:
                for err in errors: st.error(err)
            else:
                st.session_state.entries.append(entry)
                save_data(st.session_state.username,
                          st.session_state.entries)
                st.session_state.bond_rate   = None
                st.session_state.bond_status = ""
                st.session_state.stock_price  = None
                st.session_state.stock_status = ""
                st.success("✓ Entry saved!")
                st.balloons()
                st.session_state.page = "dashboard"
                st.rerun()

    with col_clear:
        if st.button("Clear", use_container_width=True, key="btn_clr"):
            st.session_state.bond_rate   = None
            st.session_state.bond_status = ""
            st.session_state.stock_price  = None
            st.session_state.stock_status = ""
            st.rerun()

# ══════════════════════════════════════════════════════════════════
#  SETTINGS PAGE
# ══════════════════════════════════════════════════════════════════
def settings_page():
    st.markdown("""
    <div style='margin:20px 0 14px'>
        <span style='font-size:11px;font-weight:700;text-transform:uppercase;
        letter-spacing:1px;color:#6C63FF'>⚙️ Settings</span>
    </div>
    """, unsafe_allow_html=True)

    tab_profile, tab_security, tab_more = st.tabs(
        ["👤 Profile","🔒 Security","📋 More"])

    with tab_profile:
        users  = load_users()
        udata  = users.get(st.session_state.username.lower(), {})
        name   = st.text_input("Display Name",
            value=udata.get("display", st.session_state.username),
            key="s_name")
        email  = st.text_input("Email Address",
            value=udata.get("email",""), key="s_email")
        if st.button("✅ Save Profile", key="btn_save_prof"):
            if not name:
                st.error("Name cannot be empty.")
            else:
                key2 = st.session_state.username.lower()
                if key2 not in users:
                    users[key2]={"display":st.session_state.username,
                                 "password":""}
                users[key2]["display"] = name
                users[key2]["email"]   = email
                save_users(users)
                st.success("✓ Profile saved!")

    with tab_security:
        old = st.text_input("Current Password", type="password", key="s_old")
        new = st.text_input("New Password",     type="password", key="s_new")
        cfm = st.text_input("Confirm New Password",type="password",key="s_cfm")
        if st.button("🔒 Update Password", key="btn_upd_pwd"):
            users = load_users()
            ud    = users.get(st.session_state.username.lower(),{})
            if not old or not new or not cfm:
                st.error("All fields are required.")
            elif ud.get("password") != _hash(old):
                st.error("Current password is incorrect.")
            elif len(new) < 4:
                st.error("New password must be at least 4 characters.")
            elif new != cfm:
                st.error("New passwords do not match.")
            else:
                users[st.session_state.username.lower()]["password"]=_hash(new)
                save_users(users)
                st.success("✓ Password updated!")

    with tab_more:
        st.markdown("**💾 Saved FGN Bond Rates**")
        rows = bond_db_all()
        if not rows:
            st.info("No rates saved yet. Fetch a bond rate and it will appear here.")
        else:
            tenor_lbl = {"3yr":"3-Year","2yr":"2-Year"}
            for month_str,year_str,tenor,rate,source,fetched_at in rows:
                c1,c2 = st.columns([3,1])
                with c1:
                    st.markdown(f"**{month_str} {year_str}** · "
                                f"{tenor_lbl.get(tenor,tenor)}")
                with c2:
                    st.markdown(f"**{rate:.3f}%** p.a.")
                st.divider()

# ══════════════════════════════════════════════════════════════════
#  ROUTER
# ══════════════════════════════════════════════════════════════════
inject_css()

if not st.session_state.logged_in:
    login_page()
else:
    topbar()
    page = st.session_state.page
    if page == "dashboard":
        dashboard_page()
    elif page == "log":
        log_page()
    elif page == "settings":
        settings_page()
    else:
        dashboard_page()
