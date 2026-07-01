"""
app.py — Wealth Builder web backend (Flask)

This is a faithful web port of the desktop Tkinter app's logic layer.
Storage format, validation rules, and live-fetch behaviour are kept
identical so the underlying data model matches exactly — only the
delivery mechanism (HTTP/JSON instead of native widgets) is different.

Browsers cannot make the kind of cross-origin scraping requests this
app needs (Nairametrics, NGX, DMO) due to CORS restrictions, so all
live-fetch logic runs here on the server and is exposed to the
frontend as simple JSON endpoints.
"""

import json, os, hashlib, re, sqlite3, secrets
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, request, jsonify, session, send_from_directory
import urllib.request
import urllib.error
import urllib.parse


# ── Storage ───────────────────────────────────────────────────────
# On Render.com the working directory is writable but ephemeral.
# We use /tmp which is always writable on any Linux server including Render.
# For a permanent solution, upgrade to Render's persistent disk ($1/month).
if os.path.exists("/tmp"):
    # Running on Linux server (Render, Railway, etc.)
    APP_DIR = "/tmp/wealthbuilder_data"
else:
    # Running locally on Windows/Mac
    APP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

USERS_FILE = os.path.join(APP_DIR, "users.json")
BOND_DB = os.path.join(APP_DIR, "bond_rates.db")
os.makedirs(APP_DIR, exist_ok=True)


def _bond_db_connect():
    conn = sqlite3.connect(BOND_DB)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS bond_rates (
            month_str   TEXT NOT NULL,
            year_str    TEXT NOT NULL,
            tenor       TEXT NOT NULL,
            rate        REAL NOT NULL,
            source      TEXT NOT NULL,
            fetched_at  TEXT NOT NULL,
            PRIMARY KEY (month_str, year_str, tenor)
        )
    """)
    return conn


def bond_db_get(month_str, year_str, tenor):
    try:
        conn = _bond_db_connect()
        cur = conn.execute(
            "SELECT rate, source, fetched_at FROM bond_rates "
            "WHERE month_str=? AND year_str=? AND tenor=?",
            (month_str, year_str, tenor))
        row = cur.fetchone()
        conn.close()
        return row
    except Exception:
        return None


def bond_db_save(month_str, year_str, tenor, rate, source):
    try:
        conn = _bond_db_connect()
        conn.execute(
            "INSERT OR REPLACE INTO bond_rates "
            "(month_str, year_str, tenor, rate, source, fetched_at) "
            "VALUES (?,?,?,?,?,?)",
            (month_str, year_str, tenor, rate, source,
             datetime.now().isoformat(timespec="seconds")))
        conn.commit()
        conn.close()
    except Exception:
        pass


def bond_db_all():
    try:
        conn = _bond_db_connect()
        cur = conn.execute(
            "SELECT month_str, year_str, tenor, rate, source, fetched_at "
            "FROM bond_rates ORDER BY year_str DESC, fetched_at DESC")
        rows = cur.fetchall()
        conn.close()
        return rows
    except Exception:
        return []


def _hash(pw):
    return hashlib.sha256(pw.encode()).hexdigest()


def _user_file(u):
    s = "".join(c for c in u.lower() if c.isalnum() or c in "-_")
    return os.path.join(APP_DIR, f"{s}_data.json")


def load_users():
    try:
        if os.path.exists(USERS_FILE):
            with open(USERS_FILE) as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def save_users(u):
    with open(USERS_FILE, "w") as f:
        json.dump(u, f, indent=2)


def load_data(u):
    try:
        p = _user_file(u)
        if os.path.exists(p):
            with open(p) as f:
                return json.load(f)
    except Exception:
        pass
    return []


def save_data(u, entries):
    with open(_user_file(u), "w") as f:
        json.dump(entries, f, indent=2)


# ── Constants ─────────────────────────────────────────────────────
_cur_year = datetime.now().year
YEARS = [str(y) for y in range(2026, max(2027, _cur_year + 6))]

MONTHS = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"]

NGX_TICKERS = sorted(set("""
ABBEYBDS ABCTRANS ACADEMY ACCESSCORP AFRIPRUD AIICO AIRTELAFRI ARADEL ARBICO
AUSTINLAZ BAPLC BERGER BETAGLAS BUACEMENT BUAFOODS CADBURY CAP CAPHOTEL CAVERTON
CHAMPION CHAMS CHELLARAM CHIPLC CILEASING CONHALLPLC CONOIL CORNERST CUSTODIAN
CUTIX CWG DAARCOMM DANGCEM DANGSUGAR DEAPCAP EKOCORP ELLAHLAKES ENAMELWA ETERNA
ETI ETRANZACT EUNISELL FCMB FIDELITYBK FIDSON FIRSTHOLDCO FTNCOCOA GEREGU
GTCO GUINEAINS GUINNESS HMCALL HONYFLOUR IKEJAHOTEL IMG INFINITY INTBREW
INTENEGINS JAIZBANK JAPAULGOLD JBERGER JOHNHOLT JULI LASACO LEARNAFRCA
LINKASSURE LIVESTOCK MANSARD MAYBAKER MBENEFIT MCNICHOLS MECURE MEYER MORISON
MTNN MULTIVERSE NAHCO NASCON NB NCR NEIMETH NEM NESTLE NEWGOLD NGXGROUP
NNFM NPFMCRFBK NSLTECH OANDO OKOMUOIL OMATEK PHARMDEKO PREMPAINTS PRESCO
PRESTIGE PZ REDSTAREX REGALINS RONCHESS ROYALEX RTBRISCOE SCOA SEPLAT SKYAVN
SOVRENINS STACO STANBIC STERLINGNG SUNUASSUR TANTALIZER THOMASWY TIP TOTAL
TRANSCOHOT TRANSCORP TRANSEXPR TRANSPOWER TRIPPLEG UACN UBA UCAP UHOMREIT
UNILEVER UNIONDICON UNITYBNK UNIVINSURE UPDC UPL VERITASKAP VETBANK VETGOODS
VFDGROUP VITAFOAM WAPCO WAPIC WEMABANK ZENITHBANK ZICHIS
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


# ── Live data fetching (server-side only — browsers can't do this) ──
_BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def _check_internet():
    try:
        urllib.request.urlopen(
            urllib.request.Request("https://www.google.com",
                                    headers=_BROWSER_HEADERS), timeout=5)
        return True
    except Exception:
        return False


def _fetch_html(url, timeout=10):
    req = urllib.request.Request(url, headers=_BROWSER_HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def _parse_tenor_rate(html, tenor):
    word = "two-year" if tenor == "2yr" else "three-year"
    digit = "2-year" if tenor == "2yr" else "3-year"
    rate_tail = r'[^.]{0,160}?(\d{1,2}\.\d{2,3})\s*(?:%|per\s*cent|percent)'
    patterns = [
        word + rate_tail,
        digit + rate_tail,
        (digit[0] + "-Year") + rate_tail,
    ]
    for p in patterns:
        m = re.search(p, html, re.IGNORECASE)
        if m:
            return float(m.group(1))
    return None


def _extract_article_links(html):
    raw = re.findall(
        r'href="(https?://nairametrics\.com/\d{4}/\d{2}/\d{2}/[a-z0-9\-]+/?)"',
        html, re.IGNORECASE)
    seen, out = set(), []
    for u in raw:
        u = u.rstrip("/") + "/"
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def _link_matches_month(link, month_str, year_str):
    um = re.search(r'nairametrics\.com/(\d{4})/(\d{2})/', link)
    if not um:
        return False
    url_year, url_month_num = um.group(1), int(um.group(2))
    target_month_num = MONTHS.index(month_str) + 1
    slug = link.rstrip("/").split("/")[-1].lower()
    has_savings_bond = "savings-bond" in slug or "savings_bond" in slug
    if not has_savings_bond:
        return False
    if url_year == year_str and url_month_num == target_month_num:
        return True
    if month_str.lower() in slug and year_str in slug:
        return True
    return False


def fetch_dmo_bond_rate_for(tenor, month_str, year_str):
    cached = bond_db_get(month_str, year_str, tenor)
    if cached:
        rate, source, fetched_at = cached
        return rate, f"{source}, saved {fetched_at[:10]}"

    if not _check_internet():
        return None, "No internet connection. Please check your connection and try again."

    try:
        target_month_num = MONTHS.index(month_str) + 1
        target_year_num = int(year_str)
    except (ValueError, TypeError):
        return None, "Invalid month or year selected."

    today = datetime.now()
    if (target_year_num, target_month_num) > (today.year, today.month):
        return None, (f"NOT_PUBLISHED:The {month_str} {year_str} FGN Savings "
                       f"Bond rate isn't available yet because that month "
                       f"hasn't arrived. DMO typically releases each "
                       f"month's rate in the first few days of that month.")

    try:
        candidate = None

        try:
            query = f"DMO {month_str} {year_str} FGN Savings Bond"
            api_url = ("https://nairametrics.com/wp-json/wp/v2/search"
                       f"?search={urllib.parse.quote(query)}&per_page=10")
            api_html = _fetch_html(api_url, timeout=10)
            api_results = json.loads(api_html)
            for item in api_results:
                link = item.get("url", "")
                if link and _link_matches_month(link, month_str, year_str):
                    candidate = link
                    break
        except (urllib.error.HTTPError, urllib.error.URLError,
                json.JSONDecodeError, ValueError):
            pass

        if not candidate:
            try:
                query = f"FGN Savings Bond {month_str} {year_str}".replace(" ", "+")
                search_url = f"https://nairametrics.com/?s={query}"
                search_html = _fetch_html(search_url, timeout=10)
                for link in _extract_article_links(search_html):
                    if _link_matches_month(link, month_str, year_str):
                        candidate = link
                        break
            except (urllib.error.HTTPError, urllib.error.URLError):
                pass

        if not candidate:
            MAX_PAGES = 24
            for page in range(1, MAX_PAGES + 1):
                listing_url = ("https://nairametrics.com/category/market-news/fixed-income/"
                                if page == 1 else
                                f"https://nairametrics.com/category/market-news/fixed-income/page/{page}/")
                try:
                    listing_html = _fetch_html(listing_url, timeout=8)
                except urllib.error.HTTPError as e:
                    if e.code == 404:
                        break
                    raise

                page_links = _extract_article_links(listing_html)
                if not page_links:
                    break

                newest_post_on_page = None
                for link in page_links:
                    um = re.search(r'nairametrics\.com/(\d{4})/(\d{2})/', link)
                    if um:
                        post_ym = (int(um.group(1)), int(um.group(2)))
                        if newest_post_on_page is None or post_ym > newest_post_on_page:
                            newest_post_on_page = post_ym
                    if _link_matches_month(link, month_str, year_str):
                        candidate = link

                if candidate:
                    break
                if newest_post_on_page is not None and \
                   newest_post_on_page < (target_year_num, target_month_num):
                    break

        if candidate:
            article_html = _fetch_html(candidate)
            rate = _parse_tenor_rate(article_html, tenor)
            if rate is not None:
                source = "Nairametrics / DMO (live)"
                bond_db_save(month_str, year_str, tenor, rate, source)
                return rate, source

        dmo_listing = _fetch_html("https://www.dmo.gov.ng/fgn-bonds/savings-bond")
        dmo_pat = re.compile(
            r'href="([^"]+savings-bond[^"]*)"[^>]*>[^<]*' +
            re.escape(month_str) + r',?\s*' + re.escape(year_str),
            re.IGNORECASE)
        m = dmo_pat.search(dmo_listing)
        if m:
            return None, (f"NOT_PUBLISHED:Found the DMO circular for "
                           f"{month_str} {year_str}, but couldn't read the "
                           f"exact rate from the PDF. Please check dmo.gov.ng "
                           f"directly and enter the rate manually.")

        return None, (f"NOT_PUBLISHED:Could not find a published "
                       f"{month_str} {year_str} FGN Savings Bond rate. "
                       f"It may not have been released yet, or our sources "
                       f"don't cover that period. Please check dmo.gov.ng "
                       f"or enter the rate manually.")

    except urllib.error.HTTPError as e:
        return None, f"Bond rate source blocked the request (HTTP {e.code}). Please try again later."
    except urllib.error.URLError:
        return None, "Could not reach the bond rate sources right now. Please try again later."
    except Exception as e:
        return None, f"Error fetching rate: {type(e).__name__}."


def fetch_ngx_stock_price(ticker):
    ticker_up = ticker.strip().upper()
    ticker_lower = ticker.strip().lower()
    if not ticker_up:
        return None, "No ticker entered."

    hdrs = _BROWSER_HEADERS

    try:
        url = f"https://afx.kwayisi.org/ngx/{ticker_lower}.html"
        req = urllib.request.Request(url, headers=hdrs)
        with urllib.request.urlopen(req, timeout=8) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        pat = re.compile(r'current share price of .*?\(' + re.escape(ticker_up) + r'\) is NGN ([\d,]+\.\d{2})')
        m = pat.search(html)
        if m:
            return float(m.group(1).replace(",", "")), "NGX live"
        nums = re.findall(r'NGN\s*([\d,]+\.\d{2})', html)
        valid = [float(n.replace(",", "")) for n in nums if 0.01 < float(n.replace(",", "")) < 100000]
        if valid:
            return valid[0], "NGX live"
    except Exception:
        pass

    try:
        url2 = f"https://stooq.com/q/?s={ticker_lower}.ng"
        req2 = urllib.request.Request(url2, headers=hdrs)
        with urllib.request.urlopen(req2, timeout=8) as resp2:
            html2 = resp2.read().decode("utf-8", errors="ignore")
        m2 = re.search(r'id="aq"[^>]*>([\d,\.]+)<', html2)
        if m2:
            return float(m2.group(1).replace(",", "")), "NGX live"
        m3 = re.search(r'"last"\s*:\s*([\d\.]+)', html2)
        if m3:
            return float(m3.group(1)), "NGX live"
    except Exception:
        pass

    try:
        url3 = f"https://ngxgroup.com/exchange/data/equities-price-list/?searchtext={ticker_up}&market="
        req3 = urllib.request.Request(url3, headers=hdrs)
        with urllib.request.urlopen(req3, timeout=8) as resp3:
            html3 = resp3.read().decode("utf-8", errors="ignore")
        pattern = re.escape(ticker_up) + r'.*?<td[^>]*>([\d,\.]+)</td>'
        m4 = re.search(pattern, html3, re.DOTALL)
        if m4:
            val = float(m4.group(1).replace(",", ""))
            if 0.01 < val < 100000:
                return val, "NGX live"
    except Exception:
        pass

    try:
        url4 = "https://ngxgroup.com/exchange/trade/equities/listed-companies/"
        req4 = urllib.request.Request(url4, headers=hdrs)
        with urllib.request.urlopen(req4, timeout=10) as resp4:
            html4 = resp4.read().decode("utf-8", errors="ignore")
        pattern4 = re.compile(
            r'\[' + re.escape(ticker_up) + r'\]\([^)]+\)\s+N([\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s*%'
        )
        m5 = pattern4.search(html4)
        if m5:
            return float(m5.group(1).replace(",", "")), "NGX official"
    except Exception:
        pass

    return None, f"Could not fetch live price for {ticker_up}. Please enter the cost price manually."


def resolve_ticker(typed):
    typed = typed.strip().upper()
    if typed in NGX_TICKERS:
        return typed
    starts_with = sorted((t for t in NGX_TICKERS if t.startswith(typed)), key=len)
    if starts_with:
        return starts_with[0]
    return typed


# ── Flask app ────────────────────────────────────────────────────
app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = os.environ.get("WEALTHBUILDER_SECRET", secrets.token_hex(32))
app.permanent_session_lifetime = timedelta(days=30)


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "username" not in session:
            return jsonify({"error": "Not logged in"}), 401
        return f(*args, **kwargs)
    return wrapper


# ── Static frontend ──────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory("static", "index.html")


# ── Auth endpoints ───────────────────────────────────────────────
@app.route("/api/register", methods=["POST"])
def register():
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()

    if not username:
        return jsonify({"error": "Please enter a username."}), 400
    if not password:
        return jsonify({"error": "Please enter a password."}), 400
    if len(password) < 4:
        return jsonify({"error": "Password must be at least 4 characters."}), 400

    users = load_users()
    if username.lower() in users:
        return jsonify({"error": "Username already taken. Try another."}), 400

    users[username.lower()] = {
        "display": username,
        "password": _hash(password),
        "email": "",
    }
    save_users(users)

    session.permanent = True
    session["username"] = username
    session["user_key"] = username.lower()
    return jsonify({"username": username})


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()

    users = load_users()
    user_data = users.get(username.lower())
    if not user_data or user_data["password"] != _hash(password):
        return jsonify({"error": "Incorrect username or password."}), 401

    session.permanent = True
    session["username"] = user_data["display"]
    session["user_key"] = username.lower()
    return jsonify({"username": user_data["display"]})


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/me")
def me():
    if "username" not in session:
        return jsonify({"username": None})
    return jsonify({"username": session["username"]})


@app.route("/api/update-password", methods=["POST"])
@login_required
def update_password():
    data = request.get_json(force=True)
    old = (data.get("old") or "").strip()
    new = (data.get("new") or "").strip()

    if not old or not new:
        return jsonify({"error": "Please fill in all password fields."}), 400
    if len(new) < 4:
        return jsonify({"error": "New password must be at least 4 characters."}), 400

    users = load_users()
    key = session.get("user_key") or session["username"].lower()
    user_record = users.get(key)
    if not user_record or user_record["password"] != _hash(old):
        return jsonify({"error": "Current password is incorrect."}), 400

    user_record["password"] = _hash(new)
    users[key] = user_record
    save_users(users)
    return jsonify({"ok": True})


@app.route("/api/profile", methods=["GET", "POST"])
@login_required
def profile():
    users = load_users()
    key = session.get("user_key") or session["username"].lower()
    user_record = users.get(key, {})

    if request.method == "GET":
        return jsonify({
            "display": user_record.get("display", session["username"]),
            "email": user_record.get("email", ""),
        })

    data = request.get_json(force=True)
    name = (data.get("display") or "").strip()
    email = (data.get("email") or "").strip()
    if not name:
        return jsonify({"error": "Display name cannot be empty."}), 400

    user_record["display"] = name
    user_record["email"] = email
    users[key] = user_record
    save_users(users)
    session["username"] = name
    # user_key stays unchanged — it's the permanent lookup key
    return jsonify({"ok": True, "username": name})


# ── Constants for the frontend ────────────────────────────────────
@app.route("/api/constants")
def constants():
    return jsonify({
        "years": YEARS,
        "months": MONTHS,
        "tickers": NGX_TICKERS,
        "equity_funds": EQUITY_FUNDS,
    })


# ── Entries CRUD ─────────────────────────────────────────────────
@app.route("/api/entries", methods=["GET"])
@login_required
def get_entries():
    return jsonify(load_data(session.get("user_key") or session["username"]))


@app.route("/api/entries", methods=["POST"])
@login_required
def add_entry():
    data = request.get_json(force=True)

    year = data.get("year")
    month = data.get("month")
    type_s = data.get("type")
    amount = data.get("amount")

    if year not in YEARS:
        return jsonify({"error": "Please select a year."}), 400
    if month not in MONTHS:
        return jsonify({"error": "Please select a month."}), 400
    if type_s not in ("bond", "bond2", "equity", "stock"):
        return jsonify({"error": "Please select an investment type."}), 400
    try:
        amount = float(amount)
        if amount <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"error": "Please enter a valid amount > 0."}), 400

    entry = {
        "id": int(datetime.now().timestamp() * 1000),
        "year": year,
        "month": month,
        "type": type_s,
        "amount": amount,
    }

    if type_s in ("bond", "bond2"):
        rate = data.get("rate")
        if rate is None:
            return jsonify({"error": "Please fetch the bond rate, or type it in, before saving."}), 400
        try:
            entry["rate"] = float(rate)
        except (TypeError, ValueError):
            return jsonify({"error": "Bond rate must be a valid number."}), 400
        tenor = "3yr" if type_s == "bond" else "2yr"
        if not bond_db_get(month, year, tenor):
            bond_db_save(month, year, tenor, entry["rate"], "Entered manually")

    elif type_s == "equity":
        fund = (data.get("fund") or "").strip()
        if not fund:
            return jsonify({"error": "Please select an equity fund."}), 400
        try:
            entry["units"] = float(data.get("units"))
        except (TypeError, ValueError):
            return jsonify({"error": "Units must be a valid number."}), 400
        try:
            entry["cost_per_unit"] = float(data.get("cost_per_unit"))
        except (TypeError, ValueError):
            return jsonify({"error": "Cost per unit must be a valid number."}), 400
        entry["fund"] = fund

    elif type_s == "stock":
        ticker = (data.get("ticker") or "").strip().upper()
        if not ticker:
            return jsonify({"error": "Please enter a stock ticker."}), 400
        try:
            entry["units"] = float(data.get("units"))
        except (TypeError, ValueError):
            return jsonify({"error": "Units must be a valid number."}), 400
        try:
            entry["cost_price"] = float(data.get("cost_price"))
        except (TypeError, ValueError):
            return jsonify({"error": "Cost per share is required and must be a valid number."}), 400
        entry["ticker"] = resolve_ticker(ticker)

    entries = load_data(session.get("user_key") or session["username"])
    entries.append(entry)
    save_data(session.get("user_key") or session["username"], entries)
    return jsonify(entry)


@app.route("/api/entries/<int:entry_id>", methods=["DELETE"])
@login_required
def delete_entry(entry_id):
    entries = load_data(session.get("user_key") or session["username"])
    entries = [e for e in entries if e["id"] != entry_id]
    save_data(session.get("user_key") or session["username"], entries)
    return jsonify({"ok": True})


# ── Live data endpoints ───────────────────────────────────────────
@app.route("/api/fetch-bond-rate", methods=["POST"])
@login_required
def api_fetch_bond_rate():
    data = request.get_json(force=True)
    tenor = data.get("tenor")
    month = data.get("month")
    year = data.get("year")

    if tenor not in ("2yr", "3yr"):
        return jsonify({"error": "Invalid tenor."}), 400
    if month not in MONTHS or year not in YEARS:
        return jsonify({"error": "Please select a Year and Month first."}), 400

    rate, source = fetch_dmo_bond_rate_for(tenor, month, year)
    if rate is not None:
        return jsonify({"rate": rate, "source": source})
    if isinstance(source, str) and source.startswith("NOT_PUBLISHED:"):
        return jsonify({"rate": None, "not_published": True,
                         "message": source.split("NOT_PUBLISHED:", 1)[1]})
    return jsonify({"rate": None, "not_published": False, "message": source})


@app.route("/api/fetch-stock-price", methods=["POST"])
@login_required
def api_fetch_stock_price():
    data = request.get_json(force=True)
    ticker = (data.get("ticker") or "").strip()
    if not ticker:
        return jsonify({"error": "No ticker provided."}), 400

    resolved = resolve_ticker(ticker)
    price, source = fetch_ngx_stock_price(resolved)
    if price is not None:
        return jsonify({"ticker": resolved, "price": price, "source": source})
    return jsonify({"ticker": resolved, "price": None, "message": source})


@app.route("/api/fetch-stock-prices-bulk", methods=["POST"])
@login_required
def api_fetch_stock_prices_bulk():
    """
    Fetches live prices for multiple tickers in one call — used to
    refresh every stock card on the dashboard without one HTTP
    round-trip per ticker.
    """
    data = request.get_json(force=True)
    tickers = data.get("tickers", [])
    if not isinstance(tickers, list):
        return jsonify({"error": "tickers must be a list."}), 400

    results = {}
    for t in set(tickers):
        resolved = resolve_ticker(t)
        price, _source = fetch_ngx_stock_price(resolved)
        results[resolved] = price
    return jsonify(results)


@app.route("/api/bond-history")
@login_required
def api_bond_history():
    rows = bond_db_all()
    return jsonify([
        {"month": r[0], "year": r[1], "tenor": r[2], "rate": r[3],
         "source": r[4], "fetched_at": r[5]}
        for r in rows
    ])


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
