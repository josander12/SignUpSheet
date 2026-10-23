import logging
import math
import os
import re
import secrets
import sqlite3
import time
import base64
from contextlib import closing
from datetime import date, datetime, timedelta
from functools import wraps
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo
from uuid import uuid4

from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, send_from_directory, session
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.exceptions import Conflict

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(ROOT_DIR, ".env"), override=False)

app = Flask(__name__, static_folder=None)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.logger.setLevel(logging.INFO)

secret_key = os.environ.get("FLASK_SECRET_KEY")
if not secret_key:
    raise RuntimeError("FLASK_SECRET_KEY must be set in the environment.")

app.secret_key = secret_key
app.config.update(
    SESSION_COOKIE_SECURE=os.environ.get("SESSION_COOKIE_SECURE", "false").lower() == "true",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    MAX_CONTENT_LENGTH=256 * 1024,
)
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
if not ADMIN_PASSWORD:
    raise RuntimeError("ADMIN_PASSWORD must be set in the environment.")
DATABASE_PATH = os.environ.get("DATABASE_PATH", os.path.join(ROOT_DIR, "volunteer_app.db"))
VOLUNTEER_TIMEZONE = ZoneInfo("America/Denver")
SMS_ALERTS_PER_DAY_LIMIT = 10


def get_db():
    if "db" not in g:
        connection = sqlite3.connect(DATABASE_PATH, timeout=30)
        connection.row_factory = sqlite3.Row
        g.db = connection
    return g.db


@app.teardown_appcontext
def close_db(_error):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def get_client_ip():
    return request.remote_addr or "unknown"


@app.before_request
def log_request_metadata():
    app.logger.info(
        "%s %s from %s",
        request.method,
        request.path,
        get_client_ip(),
    )
    if request.path.startswith("/api/") and request.method in {"POST", "PUT", "DELETE"}:
        if request.path not in {
            "/api/entries", "/api/internal/shift-reminders",
        }:
            expected = session.get("csrf_token")
            supplied = request.headers.get("X-CSRF-Token", "")
            if not expected or not secrets.compare_digest(expected.encode(), supplied.encode()):
                return jsonify({"error": "Invalid CSRF token. Reload the page and try again."}), 403


@app.after_request
def protect_api_responses(response):
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


@app.errorhandler(Conflict)
def booking_conflict(error):
    get_db().rollback()
    return jsonify({"error": error.description}), 409


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "Request is too large."}), 413


@app.errorhandler(sqlite3.OperationalError)
def database_error(error):
    if "locked" not in str(error).lower():
        raise error
    app.logger.exception("Database write contention")
    return jsonify({"error": "Database is busy. Please try again."}), 503


def text_field(payload, key, limit, required=False):
    value = payload.get(key, "")
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"{key} must be text with at most {limit} characters.")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{key} is required.")
    return value


def phone_field(payload):
    value = text_field(payload, "contact", 30)
    if not value:
        return ""
    if not re.fullmatch(r"\+?[0-9() .-]+", value):
        raise ValueError("Please provide a valid 10-digit phone number.")
    digits = re.sub(r"[^0-9]", "", value)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if not re.fullmatch(r"[2-9][0-9]{2}[2-9][0-9]{6}", digits):
        raise ValueError("Please provide a valid 10-digit phone number.")
    return f"{digits[:3]}-{digits[3:6]}-{digits[6:]}"


def internal_job_required(view):
    @wraps(view)
    def wrapped_view(*args, **kwargs):
        expected = os.environ.get("REMINDER_JOB_TOKEN", "")
        authorization = request.headers.get("Authorization", "")
        if not authorization.startswith("Bearer ") or not expected:
            return jsonify({"error": "Unauthorized."}), 401
        if not secrets.compare_digest(
            authorization.removeprefix("Bearer ").encode(), expected.encode()
        ):
            return jsonify({"error": "Unauthorized."}), 401
        return view(*args, **kwargs)

    return wrapped_view


def twilio_sms_configured():
    return sms_enabled() and twilio_sender_configured() and bool(os.environ.get("SMS_ALERT_PHONE"))


def sms_enabled():
    value = os.environ.get("SMS_ENABLED", "false").strip().lower()
    if value not in ("true", "false"):
        raise RuntimeError("SMS_ENABLED must be true or false.")
    return value == "true"


def twilio_sender_configured():
    return all(
        os.environ.get(key)
        for key in (
            "TWILIO_ACCOUNT_SID",
            "TWILIO_AUTH_TOKEN",
            "TWILIO_FROM_NUMBER",
        )
    )


def send_signup_sms(entry):
    message_body = (
        f"New signup: {entry['name'][:50]} - "
        f"{'Child care' if entry['type'] == 'childcare' else 'General'}, "
        f"{entry['date']} {entry['start']}-{entry['end']}."
    )
    send_twilio_sms(os.environ["SMS_ALERT_PHONE"], message_body)


def send_twilio_sms(destination, message_body):
    account_sid = os.environ["TWILIO_ACCOUNT_SID"]
    auth_token = os.environ["TWILIO_AUTH_TOKEN"]
    request = Request(
        f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json",
        data=urlencode(
            {
                "To": destination,
                "From": os.environ["TWILIO_FROM_NUMBER"],
                "Body": message_body,
            }
        ).encode(),
        headers={
            "Authorization": "Basic "
            + base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode(),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=15) as response:
            if response.status not in (200, 201):
                raise RuntimeError(f"Twilio returned unexpected HTTP status {response.status}.")
    except HTTPError as error:
        raise RuntimeError(f"Twilio returned HTTP status {error.code}.") from error
    except URLError as error:
        raise RuntimeError("Could not connect to Twilio.") from error


def validate_schedule(payload):
    date_value = text_field(payload, "date", 10, required=True)
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", date_value):
        raise ValueError("Date must use YYYY-MM-DD.")
    day = date.fromisoformat(date_value)
    if day < date.today():
        raise ValueError("Please choose today or a future date.")
    start = text_field(payload, "start", 5, required=True)
    end = text_field(payload, "end", 5, required=True)
    for value in (start, end):
        if not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", value):
            raise ValueError("Times must use HH:MM.")
    if end <= start:
        raise ValueError("End time must be later than the start time.")
    return day, start, end


def childcare_signups(db, need):
    # Legacy unlinked child care entries cover overlapping needs on their date.
    return db.execute(
        """
        SELECT start, end FROM entries
        WHERE type = 'childcare' AND (
            need_id = ? OR (
                COALESCE(need_id, '') = '' AND date = ?
                AND start < ? AND end > ?
            )
        )
        """,
        (need["id"], need["date"], need["end"], need["start"]),
    ).fetchall()


def protect_booked_need(db, existing, replacement=None):
    if replacement and all(
        existing[key] == replacement[key] for key in ("date", "start", "end")
    ):
        return
    if childcare_signups(db, existing):
        raise Conflict(
            "This child care need already has volunteer signups. "
            "Remove those signups before deleting or rescheduling it."
        )


def admin_required(view):
    @wraps(view)
    def wrapped_view(*args, **kwargs):
        if not session.get("admin"):
            return jsonify({"error": "Admin login required."}), 401
        return view(*args, **kwargs)

    return wrapped_view


def init_db():
    with closing(sqlite3.connect(DATABASE_PATH, timeout=30)) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS login_attempts (
                ip TEXT NOT NULL,
                attempted_at REAL NOT NULL
            )
            """,
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS login_attempts_ip_time ON login_attempts (ip, attempted_at)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                name TEXT,
                date TEXT,
                contact TEXT,
                notes TEXT,
                start TEXT,
                end TEXT,
                type TEXT,
                need_id TEXT
            )
            """,
        )
        entry_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(entries)")
        }
        if "reminder_opt_in" not in entry_columns:
            connection.execute(
                "ALTER TABLE entries ADD COLUMN reminder_opt_in INTEGER NOT NULL DEFAULT 0"
            )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS shift_reminder_attempts (
                signup_id TEXT PRIMARY KEY,
                attempted_at REAL NOT NULL,
                status TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS sms_notification_attempts (
                signup_id TEXT PRIMARY KEY,
                local_date TEXT NOT NULL,
                attempted_at REAL NOT NULL,
                status TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS sms_notification_attempts_date "
            "ON sms_notification_attempts (local_date)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS childcare_needs (
                id TEXT PRIMARY KEY,
                date TEXT,
                start TEXT,
                end TEXT,
                notes TEXT
            )
            """,
        )
        connection.commit()


init_db()


@app.route("/")
def index():
    return send_from_directory(ROOT_DIR, "index.html")


@app.route("/api/health")
def health_check():
    return jsonify({"ok": True})


@app.route("/api/entries", methods=["GET", "POST"])
def entries_api():
    db = get_db()

    if request.method == "GET":
        if session.get("admin"):
            rows = db.execute(
                "SELECT id, name, date, contact, notes, start, end, type, need_id AS needId, "
                "reminder_opt_in AS reminderOptIn FROM entries ORDER BY date, start"
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT id, date, start, end, type, need_id AS needId FROM entries ORDER BY date, start"
            ).fetchall()
        return jsonify([dict(row) for row in rows])

    if request.method == "POST":
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "Entry must be an object."}), 400

        try:
            day, start, end = validate_schedule(payload)
            contact = phone_field(payload)
            reminder_opt_in = payload.get("reminderOptIn", False)
            if not isinstance(reminder_opt_in, bool):
                raise ValueError("Reminder opt-in must be true or false.")
            if reminder_opt_in and not contact:
                raise ValueError("A phone number is required for a text reminder.")
            entry_type = payload.get("type", "general")
            if entry_type not in ("general", "childcare"):
                raise ValueError("Invalid volunteer type.")
            need_id = None
            if entry_type == "general":
                window = ("08:30", "14:00") if day.weekday() == 5 else ("11:45", "17:45")
                if day.weekday() not in (0, 2, 5):
                    raise ValueError("General volunteering is Monday, Wednesday, or Saturday.")
                if start < window[0] or end > window[1]:
                    raise ValueError("Times must fall within the volunteer window.")
                if any(int(value[3:]) % 15 for value in (start, end)):
                    raise ValueError("General volunteer times must use 15-minute increments.")
                if payload.get("needId") is not None:
                    raise ValueError("General volunteering cannot reference a child care need.")
            else:
                need_id = text_field(payload, "needId", 200, required=True)
                # Serialize the coverage check and insert with need changes.
                db.execute("BEGIN IMMEDIATE")
                need = db.execute("SELECT * FROM childcare_needs WHERE id = ?", (need_id,)).fetchone()
                if not need or need["date"] != day.isoformat():
                    raise ValueError("Select an existing child care need for this date.")
                if start < need["start"] or end > need["end"]:
                    raise ValueError("Times must fall within the posted child care need.")
                if any(
                    signup["start"] < end and signup["end"] > start
                    for signup in childcare_signups(db, need)
                ):
                    raise Conflict(
                        "This child care time is already covered by another signup. "
                        "Reload the calendar to see current availability."
                    )
            entry = {
                "id": str(uuid4()),
                "name": text_field(payload, "name", 120, required=True),
                "date": day.isoformat(),
                "contact": contact,
                "reminderOptIn": reminder_opt_in,
                "notes": text_field(payload, "notes", 2000),
                "start": start,
                "end": end,
                "type": entry_type,
                "needId": need_id,
            }
        except ValueError as error:
            db.rollback()
            return jsonify({"error": str(error)}), 400

        db.execute(
            """
            INSERT INTO entries
            (id, name, date, contact, notes, start, end, type, need_id, reminder_opt_in)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entry["id"],
                entry["name"],
                entry["date"],
                entry["contact"],
                entry["notes"],
                entry["start"],
                entry["end"],
                entry["type"],
                entry["needId"],
                int(reminder_opt_in),
            ),
        )
        sms_attempt_reserved = False
        if twilio_sms_configured():
            local_date = datetime.now(VOLUNTEER_TIMEZONE).date().isoformat()
            attempts_today = db.execute(
                "SELECT COUNT(*) FROM sms_notification_attempts WHERE local_date = ?",
                (local_date,),
            ).fetchone()[0]
            if attempts_today < SMS_ALERTS_PER_DAY_LIMIT:
                db.execute(
                    """
                    INSERT INTO sms_notification_attempts
                    (signup_id, local_date, attempted_at, status)
                    VALUES (?, ?, ?, 'sending')
                    """,
                    (entry["id"], local_date, time.time()),
                )
                sms_attempt_reserved = True
            else:
                app.logger.warning(
                    "Daily signup SMS limit reached; alert skipped for signup %s.",
                    entry["id"],
                )
        db.commit()
        if sms_attempt_reserved:
            try:
                send_signup_sms(entry)
            except (HTTPError, URLError, RuntimeError, OSError):
                app.logger.exception("Could not send signup SMS for entry %s.", entry["id"])
                db.execute(
                    "UPDATE sms_notification_attempts SET status = 'failed' WHERE signup_id = ?",
                    (entry["id"],),
                )
                db.commit()
            else:
                db.execute(
                    "UPDATE sms_notification_attempts SET status = 'sent' WHERE signup_id = ?",
                    (entry["id"],),
                )
                db.commit()
        return jsonify({"ok": True, "entry": entry})


@app.route("/api/internal/shift-reminders", methods=["POST"])
@internal_job_required
def send_shift_reminder():
    if not sms_enabled():
        return jsonify({"processed": False, "reason": "sms_disabled"}), 200
    now_local = datetime.now(VOLUNTEER_TIMEZONE)
    if now_local.hour < 16:
        return jsonify({"processed": False, "reason": "not_due"}), 200
    tomorrow = (now_local.date() + timedelta(days=1)).isoformat()
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    entry = db.execute(
        """
        SELECT id, contact, date, start, end, type FROM entries
        WHERE date = ? AND reminder_opt_in = 1
        AND NOT EXISTS (
            SELECT 1 FROM shift_reminder_attempts WHERE signup_id = entries.id
        )
        ORDER BY start, id LIMIT 1
        """,
        (tomorrow,),
    ).fetchone()
    if not entry:
        db.commit()
        return jsonify({"processed": False, "reason": "complete"}), 200
    if not twilio_sender_configured():
        db.rollback()
        app.logger.error("Twilio settings are missing for volunteer reminders.")
        return jsonify({"error": "Twilio reminder settings are not configured."}), 503
    # Claim before sending: retries after a timeout must not send duplicate texts.
    db.execute(
        "INSERT INTO shift_reminder_attempts VALUES (?, ?, 'sending')",
        (entry["id"], time.time()),
    )
    db.commit()
    start = datetime.strptime(entry["start"], "%H:%M").strftime("%I:%M %p").lstrip("0")
    end = datetime.strptime(entry["end"], "%H:%M").strftime("%I:%M %p").lstrip("0")
    shift_type = "child care" if entry["type"] == "childcare" else "housebuilding"
    body = (
        f"House Help reminder: your {shift_type} volunteer shift is tomorrow "
        f"({entry['date']}), {start}-{end} Utah time. Reply STOP to opt out."
    )
    destination = "+1" + re.sub(r"[^0-9]", "", entry["contact"])
    try:
        send_twilio_sms(destination, body)
    except (RuntimeError, OSError):
        app.logger.exception("Could not send reminder for signup %s.", entry["id"])
        status = "failed"
    else:
        status = "accepted"
    db.execute(
        "UPDATE shift_reminder_attempts SET status = ? WHERE signup_id = ?",
        (status, entry["id"]),
    )
    db.commit()
    return jsonify({"processed": True, "accepted": status == "accepted"}), 200


@app.route("/api/entries/<entry_id>", methods=["DELETE"])
@admin_required
def delete_entry(entry_id):
    db = get_db()
    db.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/childcare-needs", methods=["GET", "PUT"])
def childcare_needs_api():
    if request.method == "PUT" and not session.get("admin"):
        return jsonify({"error": "Admin login required."}), 401

    db = get_db()

    if request.method == "GET":
        rows = db.execute(
            "SELECT id, date, start, end, notes FROM childcare_needs ORDER BY date, start"
        ).fetchall()
        return jsonify([dict(row) for row in rows])

    payload = request.get_json(silent=True)
    if not isinstance(payload, list):
        return jsonify({"error": "Child care needs must be a list."}), 400

    needs = []
    ids = set()
    db.execute("BEGIN IMMEDIATE")
    existing_needs = {
        row["id"]: dict(row) for row in db.execute("SELECT * FROM childcare_needs").fetchall()
    }
    for need in payload:
        if not isinstance(need, dict):
            db.rollback()
            return jsonify({"error": "Each child care need must be an object."}), 400
        try:
            # Existing needs can be retained after their date has passed.
            existing = existing_needs.get(text_field(need, "id", 200, required=True))
            if existing and existing == need:
                validated = existing
            else:
                day, start, end = validate_schedule(need)
                validated = {
                    "id": text_field(need, "id", 200, required=True),
                    "date": day.isoformat(), "start": start, "end": end,
                    "notes": text_field(need, "notes", 2000),
                }
            if validated["id"] in ids:
                raise ValueError("Child care need IDs must be unique.")
            ids.add(validated["id"])
            needs.append(validated)
        except ValueError as error:
            db.rollback()
            return jsonify({"error": str(error)}), 400
    replacements = {need["id"]: need for need in needs}
    for need_id, existing in existing_needs.items():
        protect_booked_need(db, existing, replacements.get(need_id))
    db.execute("DELETE FROM childcare_needs")
    for need in needs:
        db.execute(
            """
            INSERT INTO childcare_needs (id, date, start, end, notes)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                need.get("id"),
                need.get("date"),
                need.get("start"),
                need.get("end"),
                need.get("notes", ""),
            ),
        )
    db.commit()
    rows = db.execute(
        "SELECT id, date, start, end, notes FROM childcare_needs ORDER BY date, start"
    ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.route("/api/childcare-needs/<need_id>", methods=["DELETE"])
@admin_required
def delete_childcare_need(need_id):
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    existing = db.execute("SELECT * FROM childcare_needs WHERE id = ?", (need_id,)).fetchone()
    if existing:
        protect_booked_need(db, existing)
    db.execute("DELETE FROM childcare_needs WHERE id = ?", (need_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/admin-status")
def admin_status():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify({"isAdmin": bool(session.get("admin")), "csrfToken": session["csrf_token"]})


@app.route("/api/admin-login", methods=["POST"])
def admin_login():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get("password"), str):
        return jsonify({"error": "Password must be text."}), 400
    password = payload.get("password", "")
    db = get_db()
    now = time.time()
    ip = get_client_ip()
    db.execute("BEGIN IMMEDIATE")
    db.execute("DELETE FROM login_attempts WHERE attempted_at <= ?", (now - 900,))
    attempts = db.execute(
        "SELECT COUNT(*) AS count, MIN(attempted_at) AS oldest FROM login_attempts WHERE ip = ?",
        (ip,),
    ).fetchone()
    if attempts["count"] >= 5:
        retry_after = max(1, math.ceil(attempts["oldest"] + 900 - now))
        db.commit()
        response = jsonify({"error": f"Too many login attempts. Try again in {retry_after} seconds."})
        response.headers["Retry-After"] = str(retry_after)
        return response, 429
    if secrets.compare_digest(password.encode(), ADMIN_PASSWORD.encode()):
        db.execute("DELETE FROM login_attempts WHERE ip = ?", (ip,))
        db.commit()
        session["admin"] = True
        return jsonify({"ok": True})
    db.execute("INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)", (ip, now))
    db.commit()
    return jsonify({"ok": False, "error": "Incorrect password."}), 401


@app.route("/api/admin-logout", methods=["POST"])
def admin_logout():
    session.pop("admin", None)
    return jsonify({"ok": True})


@app.route("/privacy", defaults={"filename": "privacy.html"})
@app.route("/terms", defaults={"filename": "terms.html"})
@app.route("/<path:filename>")
def serve_static(filename):
    public_files = {
        "index.html", "project-info.html", "privacy.html", "terms.html", "styles.css", "favicon.svg",
        "js/script.js", "js/state.js", "js/date-time.js", "js/data.js", "js/views.js",
    }
    if filename not in public_files:
        return jsonify({"error": "Not found."}), 404
    return send_from_directory(ROOT_DIR, filename)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
