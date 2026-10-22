import logging
import os
import sqlite3
from functools import wraps

from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, send_from_directory, session
from werkzeug.middleware.proxy_fix import ProxyFix

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(ROOT_DIR, ".env"), override=False)

app = Flask(__name__, static_folder=".", static_url_path="")
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.logger.setLevel(logging.INFO)

secret_key = os.environ.get("FLASK_SECRET_KEY")
if not secret_key:
    raise RuntimeError("FLASK_SECRET_KEY must be set in the environment.")

app.secret_key = secret_key
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
if not ADMIN_PASSWORD:
    raise RuntimeError("ADMIN_PASSWORD must be set in the environment.")
DATABASE_PATH = os.environ.get("DATABASE_PATH", os.path.join(ROOT_DIR, "volunteer_app.db"))


def get_db():
    if "db" not in g:
        connection = sqlite3.connect(DATABASE_PATH)
        connection.row_factory = sqlite3.Row
        g.db = connection
    return g.db


@app.teardown_appcontext
def close_db(_error):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def get_client_ip():
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.remote_addr or "unknown"


@app.before_request
def log_request_metadata():
    app.logger.info(
        "%s %s from %s",
        request.method,
        request.path,
        get_client_ip(),
    )


def admin_required(view):
    @wraps(view)
    def wrapped_view(*args, **kwargs):
        if not session.get("admin"):
            return jsonify({"error": "Admin login required."}), 401
        return view(*args, **kwargs)

    return wrapped_view


def init_db():
    with sqlite3.connect(DATABASE_PATH) as connection:
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
    return jsonify({"ok": True, "database": DATABASE_PATH})


@app.route("/api/entries", methods=["GET", "POST", "PUT"])
def entries_api():
    if request.method == "PUT" and not session.get("admin"):
        return jsonify({"error": "Admin login required."}), 401

    db = get_db()

    if request.method == "GET":
        if session.get("admin"):
            rows = db.execute(
                "SELECT id, name, date, contact, notes, start, end, type, need_id AS needId FROM entries ORDER BY date, start"
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT id, date, start, end, type, need_id AS needId FROM entries ORDER BY date, start"
            ).fetchall()
        return jsonify([dict(row) for row in rows])

    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"error": "Entry must be an object."}), 400

        entry = {
            "id": payload.get("id"),
            "name": payload.get("name", ""),
            "date": payload.get("date"),
            "contact": payload.get("contact", ""),
            "notes": payload.get("notes", ""),
            "start": payload.get("start"),
            "end": payload.get("end"),
            "type": payload.get("type", "general"),
            "needId": payload.get("needId"),
        }

        db.execute(
            """
            INSERT INTO entries (id, name, date, contact, notes, start, end, type, need_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            ),
        )
        db.commit()
        return jsonify({"ok": True, "entry": entry})

    payload = request.get_json(silent=True) or []
    if not isinstance(payload, list):
        return jsonify({"error": "Entries must be a list."}), 400

    db.execute("DELETE FROM entries")
    for entry in payload:
        db.execute(
            """
            INSERT INTO entries (id, name, date, contact, notes, start, end, type, need_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entry.get("id"),
                entry.get("name", ""),
                entry.get("date"),
                entry.get("contact", ""),
                entry.get("notes", ""),
                entry.get("start"),
                entry.get("end"),
                entry.get("type", "general"),
                entry.get("needId"),
            ),
        )
    db.commit()
    rows = db.execute(
        "SELECT id, name, date, contact, notes, start, end, type, need_id AS needId FROM entries ORDER BY date, start"
    ).fetchall()
    return jsonify([dict(row) for row in rows])


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

    payload = request.get_json(silent=True) or []
    if not isinstance(payload, list):
        return jsonify({"error": "Child care needs must be a list."}), 400

    db.execute("DELETE FROM childcare_needs")
    for need in payload:
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
    db.execute("DELETE FROM childcare_needs WHERE id = ?", (need_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/admin-status")
def admin_status():
    return jsonify({"isAdmin": bool(session.get("admin"))})


@app.route("/api/admin-login", methods=["POST"])
def admin_login():
    payload = request.get_json(silent=True) or {}
    password = payload.get("password", "")

    if password == ADMIN_PASSWORD:
        session["admin"] = True
        return jsonify({"ok": True})

    return jsonify({"ok": False, "error": "Incorrect password."}), 401


@app.route("/api/admin-logout", methods=["POST"])
def admin_logout():
    session.pop("admin", None)
    return jsonify({"ok": True})


@app.route("/<path:filename>")
def serve_static(filename):
    if filename in {"index.html", "styles.css", "script.js"}:
        return send_from_directory(ROOT_DIR, filename)

    return send_from_directory(ROOT_DIR, filename)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
