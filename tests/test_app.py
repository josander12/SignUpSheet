import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from uuid import UUID


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="signup-api-tests-")
        cls.database = str(Path(cls.directory.name) / "test.db")
        environment = {
            "FLASK_SECRET_KEY": "test-secret",
            "ADMIN_PASSWORD": "test-password",
            "DATABASE_PATH": cls.database,
            "SESSION_COOKIE_SECURE": "true",
        }
        with patch.dict(os.environ, environment):
            spec = importlib.util.spec_from_file_location(
                "signup_test_app", Path(__file__).resolve().parents[1] / "app.py"
            )
            cls.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.module)
        cls.app = cls.module.app
        cls.app.config["TESTING"] = True
        cls.app.logger.setLevel("ERROR")

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def setUp(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            for table in ("entries", "childcare_needs", "login_attempts"):
                db.execute(f"DELETE FROM {table}")
        self.client = self.app.test_client()
        self.token = self.client.get("/api/admin-status").json["csrfToken"]
        self.headers = {"X-CSRF-Token": self.token}
        self.entry = {
            "name": "Test Volunteer", "contact": "test@example.invalid",
            "date": "2099-01-05", "start": "11:45", "end": "12:45",
            "type": "general", "notes": "",
        }

    def login(self):
        response = self.client.post(
            "/api/admin-login", json={"password": "test-password"}, headers=self.headers
        )
        self.assertEqual(response.status_code, 200)

    def test_valid_entry_uses_server_uuid_and_redacts_public_response(self):
        response = self.client.post("/api/entries", json={**self.entry, "id": "chosen-id"})
        self.assertEqual(response.status_code, 200)
        saved = response.json["entry"]
        self.assertEqual(UUID(saved["id"]).version, 4)
        self.assertNotEqual(saved["id"], "chosen-id")
        public = self.client.get("/api/entries").json[0]
        self.assertTrue({"name", "contact", "notes"}.isdisjoint(public))
        self.login()
        self.assertEqual(self.client.get("/api/entries").json[0]["contact"], self.entry["contact"])

    def test_invalid_entries_are_rejected_without_writes(self):
        cases = [
            {"date": "2099-02-30"}, {"date": "2099-1-05"}, {"date": "2000-01-01"},
            {"date": "2099-01-06"}, {"start": "24:00"}, {"end": "11:45"},
            {"start": "10:00"}, {"end": "18:00"}, {"start": "11:46"},
            {"type": "other"}, {"type": []}, {"name": " "}, {"contact": ""},
            {"name": 123}, {"name": "n" * 121}, {"contact": "c" * 255},
            {"notes": "n" * 2001}, {"needId": "unexpected"},
            {"type": "childcare", "needId": "missing"},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                response = self.client.post("/api/entries", json={**self.entry, **changes})
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.json)
        self.assertEqual(self.client.get("/api/entries").json, [])
        for payload in ([], None, "string", 1):
            self.assertEqual(self.client.post("/api/entries", json=payload).status_code, 400)

    def test_saturday_window(self):
        entry = {**self.entry, "date": "2099-01-03", "start": "08:30", "end": "14:00"}
        self.assertEqual(self.client.post("/api/entries", json=entry).status_code, 200)
        entry["end"] = "14:15"
        self.assertEqual(self.client.post("/api/entries", json=entry).status_code, 400)

    def test_childcare_need_validation_and_atomic_replacement(self):
        self.login()
        need = {
            "id": "need-1", "date": "2099-01-06",
            "start": "09:10", "end": "10:10", "notes": "",
        }
        response = self.client.put("/api/childcare-needs", json=[need], headers=self.headers)
        self.assertEqual(response.status_code, 200)
        for invalid in ([need, {**need, "end": "09:00"}], [need, need], [None], {}):
            response = self.client.put("/api/childcare-needs", json=invalid, headers=self.headers)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(self.client.get("/api/childcare-needs").json, [need])
        entry = {
            **self.entry, "type": "childcare", "needId": "need-1",
            "date": need["date"], "start": "09:10", "end": "10:10",
        }
        self.assertEqual(self.client.post("/api/entries", json=entry).status_code, 200)
        for changes in ({"start": "09:00"}, {"date": "2099-01-05"}, {"needId": None}):
            self.assertEqual(
                self.client.post("/api/entries", json={**entry, **changes}).status_code, 400
            )

    def test_csrf_for_every_session_mutation(self):
        endpoints = [
            ("post", "/api/admin-login", {"password": "test-password"}),
            ("post", "/api/admin-logout", {}),
            ("put", "/api/childcare-needs", []),
            ("delete", "/api/entries/missing", {}),
            ("delete", "/api/childcare-needs/missing", {}),
        ]
        for method, url, payload in endpoints:
            self.assertEqual(getattr(self.client, method)(url, json=payload).status_code, 403)
        self.login()
        for method, url, payload in endpoints[1:]:
            response = getattr(self.client, method)(url, json=payload)
            self.assertEqual(response.status_code, 403)
        self.assertTrue(self.client.get("/api/admin-status").json["isAdmin"])
        self.assertEqual(
            self.client.delete("/api/entries/missing", headers=self.headers).status_code, 200
        )
        self.assertEqual(
            self.client.post("/api/admin-logout", headers=self.headers).status_code, 200
        )
        self.assertFalse(self.client.get("/api/admin-status").json["isAdmin"])
        self.assertEqual(
            self.client.delete("/api/entries/missing", headers=self.headers).status_code, 401
        )

    def create_childcare_need(self):
        self.login()
        need = {
            "id": "need-1", "date": "2099-01-06",
            "start": "09:00", "end": "11:00", "notes": "",
        }
        response = self.client.put("/api/childcare-needs", json=[need], headers=self.headers)
        self.assertEqual(response.status_code, 200)
        return need

    def childcare_entry(self, need, **changes):
        return {
            **self.entry, "type": "childcare", "needId": need["id"],
            "date": need["date"], "start": need["start"], "end": need["end"], **changes,
        }

    def test_childcare_overlap_rejected_but_adjacent_partial_shifts_allowed(self):
        need = self.create_childcare_need()
        response = self.client.post(
            "/api/entries", json=self.childcare_entry(need, end="10:00")
        )
        self.assertEqual(response.status_code, 200)
        for start, end in (("09:00", "10:00"), ("09:30", "10:30"), ("09:15", "09:45"),
                           ("09:00", "11:00")):
            response = self.client.post(
                "/api/entries", json=self.childcare_entry(need, start=start, end=end)
            )
            self.assertEqual(response.status_code, 409)
            self.assertIn("already", response.json["error"])
        self.assertEqual(self.client.post(
            "/api/entries", json=self.childcare_entry(need, start="10:00")
        ).status_code, 200)
        self.assertEqual(len(self.client.get("/api/entries").json), 2)
        other = {**need, "id": "need-2"}
        self.assertEqual(self.client.put(
            "/api/childcare-needs", json=[need, other], headers=self.headers
        ).status_code, 200)
        self.assertEqual(self.client.post(
            "/api/entries", json=self.childcare_entry(other)
        ).status_code, 200)

    def test_concurrent_childcare_signups_have_one_winner(self):
        need = self.create_childcare_need()
        barrier = Barrier(2)

        def signup(_index):
            with self.app.test_client() as client:
                barrier.wait(timeout=5)
                return client.post("/api/entries", json=self.childcare_entry(need)).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(signup, range(2))), [200, 409])
        self.assertEqual(len(self.client.get("/api/entries").json), 1)

    def test_booked_need_cannot_be_deleted_or_rescheduled(self):
        need = self.create_childcare_need()
        signup = self.client.post("/api/entries", json=self.childcare_entry(need)).json["entry"]
        for replacement in (
            [], [{**need, "date": "2099-01-07"}],
            [{**need, "start": "09:30"}], [{**need, "end": "12:00"}],
            [{**need, "id": "renamed-need"}],
        ):
            response = self.client.put(
                "/api/childcare-needs", json=replacement, headers=self.headers
            )
            self.assertEqual(response.status_code, 409)
            self.assertIn("Remove", response.json["error"])
            self.assertEqual(self.client.get("/api/childcare-needs").json, [need])
        response = self.client.delete("/api/childcare-needs/need-1", headers=self.headers)
        self.assertEqual(response.status_code, 409)
        updated = {**need, "notes": "Updated arrival instructions"}
        self.assertEqual(self.client.put(
            "/api/childcare-needs", json=[updated], headers=self.headers
        ).status_code, 200)
        self.assertEqual(self.client.delete(
            f"/api/entries/{signup['id']}", headers=self.headers
        ).status_code, 200)
        self.assertEqual(self.client.put(
            "/api/childcare-needs", json=[], headers=self.headers
        ).status_code, 200)
        self.assertEqual(self.client.get("/api/childcare-needs").json, [])

    def test_unbooked_need_can_be_deleted_directly(self):
        self.create_childcare_need()
        self.assertEqual(self.client.delete(
            "/api/childcare-needs/need-1", headers=self.headers
        ).status_code, 200)
        self.assertEqual(self.client.get("/api/childcare-needs").json, [])

    def test_concurrent_booking_and_need_removal_never_orphan_signup(self):
        for method in ("put", "delete"):
            with self.subTest(method=method):
                with closing(sqlite3.connect(self.database)) as db, db:
                    db.execute("DELETE FROM entries")
                    db.execute("DELETE FROM childcare_needs")
                need = self.create_childcare_need()
                barrier = Barrier(2)

                def signup():
                    with self.app.test_client() as client:
                        barrier.wait(timeout=5)
                        return client.post(
                            "/api/entries", json=self.childcare_entry(need)
                        ).status_code

                def remove():
                    with self.app.test_client() as client:
                        with client.session_transaction() as session:
                            session["admin"] = True
                            session["csrf_token"] = "race-token"
                        barrier.wait(timeout=5)
                        headers = {"X-CSRF-Token": "race-token"}
                        if method == "put":
                            return client.put(
                                "/api/childcare-needs", json=[], headers=headers
                            ).status_code
                        return client.delete(
                            "/api/childcare-needs/need-1", headers=headers
                        ).status_code

                with ThreadPoolExecutor(max_workers=2) as pool:
                    booking = pool.submit(signup)
                    removal = pool.submit(remove)
                    statuses = (booking.result(), removal.result())
                self.assertIn(statuses, ((200, 409), (400, 200)))
                entries = self.client.get("/api/entries").json
                needs = self.client.get("/api/childcare-needs").json
                self.assertEqual(bool(entries), bool(needs))

    def test_legacy_unlinked_childcare_coverage_is_respected(self):
        need = self.create_childcare_need()
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute(
                """INSERT INTO entries (id, date, start, end, type, need_id)
                   VALUES ('legacy', ?, '09:00', '10:00', 'childcare', NULL)""",
                (need["date"],),
            )
        self.assertEqual(self.client.post(
            "/api/entries", json=self.childcare_entry(need, end="10:00")
        ).status_code, 409)
        self.assertEqual(self.client.put(
            "/api/childcare-needs", json=[], headers=self.headers
        ).status_code, 409)
        self.assertEqual(self.client.delete(
            "/api/childcare-needs/need-1", headers=self.headers
        ).status_code, 409)
        self.assertEqual(self.client.post(
            "/api/entries", json=self.childcare_entry(need, start="10:00")
        ).status_code, 200)

    def test_retry_after_tracks_oldest_failure_expiry(self):
        now = time.time()
        for offset in (0, 10, 20, 30, 40):
            with patch.object(self.module.time, "time", return_value=now + offset):
                self.assertEqual(self.client.post(
                    "/api/admin-login", json={"password": "wrong"}, headers=self.headers
                ).status_code, 401)
        with patch.object(self.module.time, "time", return_value=now + 60.2):
            response = self.client.post(
                "/api/admin-login", json={"password": "wrong"}, headers=self.headers
            )
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.headers["Retry-After"], "840")
            self.assertIn("840 seconds", response.json["error"])
        with patch.object(self.module.time, "time", return_value=now + 900):
            self.login()

    def test_security_headers_on_pages_assets_api_and_errors(self):
        for url in ("/", "/project-info.html", "/js/script.js", "/styles.css",
                    "/api/health", "/missing-asset"):
            with self.client.get(url) as response:
                policy = response.headers["Content-Security-Policy"]
                for directive in (
                    "default-src 'self'", "script-src 'self'", "style-src 'self'",
                    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
                    "form-action 'self'",
                ):
                    self.assertIn(directive, policy)
                self.assertNotIn("unsafe-inline", policy)
                self.assertEqual(response.headers["X-Frame-Options"], "DENY")
                self.assertEqual(response.headers["Referrer-Policy"], "strict-origin-when-cross-origin")

    def test_login_throttling_persists_and_expires(self):
        now = time.time()
        with patch.object(self.module.time, "time", return_value=now):
            for _ in range(5):
                self.assertEqual(self.client.post(
                    "/api/admin-login", json={"password": "wrong"}, headers=self.headers
                ).status_code, 401)
            response = self.client.post(
                "/api/admin-login", json={"password": "test-password"}, headers=self.headers
            )
            self.assertEqual(response.status_code, 429)
            self.assertIn("Retry-After", response.headers)
        with patch.object(self.module.time, "time", return_value=now + 901):
            self.login()

    def test_concurrent_writes_and_login_limit(self):
        def signup(_index):
            with self.app.test_client() as client:
                return client.post("/api/entries", json=self.entry).status_code

        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(list(pool.map(signup, range(12))), [200] * 12)
        entries = self.client.get("/api/entries").json
        self.assertEqual(len({entry["id"] for entry in entries}), 12)

        def attempt(index):
            with self.app.test_client() as client:
                token = client.get("/api/admin-status").json["csrfToken"]
                return client.post(
                    "/api/admin-login", json={"password": "wrong"},
                    headers={"X-CSRF-Token": token,
                             "X-Forwarded-For": f"spoofed-{index}, 127.0.0.1"},
                ).status_code

        with ThreadPoolExecutor(max_workers=4) as pool:
            statuses = list(pool.map(attempt, range(8)))
        self.assertEqual(statuses.count(401), 5)
        self.assertEqual(statuses.count(429), 3)

    def test_private_files_not_served_and_health_is_minimal(self):
        for filename in (
            ".env", "app.py", "volunteer_app.db", "volunteer_app.db-wal",
            "info.txt", "requirements.txt", "tests/test_app.py", "js/../app.py",
        ):
            self.assertEqual(self.client.get("/" + filename).status_code, 404, filename)
        for filename in ("", "index.html", "styles.css", "favicon.svg", "project-info.html",
                         "js/script.js", "js/state.js", "js/views.js", "js/data.js", "js/date-time.js"):
            with self.client.get("/" + filename) as response:
                self.assertEqual(response.status_code, 200, filename)
        self.assertEqual(self.client.get("/api/health").json, {"ok": True})

    def test_cookie_cache_body_limit_and_wal(self):
        response = self.app.test_client().get("/api/admin-status")
        cookie = response.headers["Set-Cookie"]
        for flag in ("Secure", "HttpOnly", "SameSite=Lax"):
            self.assertIn(flag, cookie)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        response = self.client.post(
            "/api/entries", data="x" * (256 * 1024 + 1), content_type="application/json"
        )
        self.assertEqual(response.status_code, 413)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")


if __name__ == "__main__":
    unittest.main()
