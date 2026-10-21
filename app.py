import os
from flask import Flask, jsonify, request, send_from_directory, session

app = Flask(__name__, static_folder=".", static_url_path="")
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key-change-me")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "househelp2026")

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))


@app.route("/")
def index():
    return send_from_directory(ROOT_DIR, "index.html")


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
    app.run(host="0.0.0.0", port=5000, debug=True)
