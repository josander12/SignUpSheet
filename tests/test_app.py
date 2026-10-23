import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier
from urllib.parse import parse_qs
from unittest.mock import patch
from uuid import UUID
from zoneinfo import ZoneInfo


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
            "REMINDER_JOB_TOKEN": "reminder-test-token",
            "TWILIO_ACCOUNT_SID": "",
            "TWILIO_AUTH_TOKEN": "",
            "TWILIO_FROM_NUMBER": "",
            "SMS_ALERT_PHONE": "",
            "SMS_ENABLED": "true",
        }
        cls.test_environment = environment
        with patch.dict(os.environ, environment):
            spec = importlib.util.spec_from_file_location(
                "signup_test_app", Path(__file__).resolve().parents[1] / "app.py"
            )
            cls.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.module)
        cls.reminder_token = environment["REMINDER_JOB_TOKEN"]
        cls.app = cls.module.app
        cls.app.config["TESTING"] = True
        cls.app.logger.setLevel("ERROR")

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def setUp(self):
        environment_patcher = patch.dict(os.environ, self.test_environment)
        environment_patcher.start()
        self.addCleanup(environment_patcher.stop)
        with closing(sqlite3.connect(self.database)) as db, db:
            for table in (
                "entries", "childcare_needs", "login_attempts",
                "sms_notification_attempts", "shift_reminder_attempts",
            ):
                db.execute(f"DELETE FROM {table}")
        self.client = self.app.test_client()
        self.token = self.client.get("/api/admin-status").json["csrfToken"]
        self.headers = {"X-CSRF-Token": self.token}
        self.reminder_headers = {
            "".join(("Author", "ization")): "".join(("Be", "arer"))
            + " "
            + self.reminder_token
        }
        self.entry = {
            "name": "Test Volunteer", "contact": "801-555-1234",
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

    def test_contact_is_optional(self):
        for contact in (None, ""):
            with self.subTest(contact=contact):
                payload = {**self.entry}
                if contact is None:
                    payload.pop("contact")
                else:
                    payload["contact"] = contact
                response = self.client.post("/api/entries", json=payload)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json["entry"]["contact"], "")

    def test_phone_validation_and_explicit_reminder_consent(self):
        for phone in ("8015551234", "(801) 555-1234", "+1 801-555-1234"):
            with self.subTest(phone=phone):
                response = self.client.post(
                    "/api/entries",
                    json={**self.entry, "contact": phone, "reminderOptIn": True},
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json["entry"]["contact"], "801-555-1234")
                self.assertIs(response.json["entry"]["reminderOptIn"], True)
        for changes in (
            {"contact": "person@example.invalid"},
            {"contact": "801-555"},
            {"contact": "123-456-7890"},
            {"contact": "", "reminderOptIn": True},
            {"reminderOptIn": "true"},
            {"reminderOptIn": 1},
            {"reminderOptIn": None},
        ):
            with self.subTest(changes=changes):
                response = self.client.post("/api/entries", json={**self.entry, **changes})
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.json)
        response = self.client.post("/api/entries", json=self.entry)
        self.assertIs(response.json["entry"]["reminderOptIn"], False)
        public = self.client.get("/api/entries").json
        self.assertTrue(all("reminderOptIn" not in row for row in public))

    def add_reminder_entry(self, entry_id, day="2099-01-05", opted_in=True):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute(
                """
                INSERT INTO entries
                (id, name, date, contact, start, end, type, reminder_opt_in)
                VALUES (?, 'Volunteer', ?, '801-555-1234', '11:45', '12:45', 'general', ?)
                """,
                (entry_id, day, int(opted_in)),
            )

    def request_reminder_at(self, local_time, client=None):
        with patch.object(self.module, "datetime", wraps=datetime) as clock:
            clock.now.return_value = local_time
            response = (client or self.client).post(
                "/api/internal/shift-reminders", headers=self.reminder_headers
            )
            clock.now.assert_called_once_with(ZoneInfo("America/Denver"))
            return response

    def test_reminders_only_send_for_tomorrow_with_consent_and_never_duplicate(self):
        self.add_reminder_entry("eligible")
        self.add_reminder_entry("no-consent", opted_in=False)
        self.add_reminder_entry("today", day="2099-01-04")
        self.add_reminder_entry("later", day="2099-01-06")
        before = datetime(2099, 1, 4, 15, 59, tzinfo=ZoneInfo("America/Denver"))
        after = datetime(2099, 1, 4, 16, 0, tzinfo=ZoneInfo("America/Denver"))
        with patch.object(self.module, "twilio_sender_configured", return_value=True), patch.object(
            self.module, "send_twilio_sms"
        ) as send:
            self.assertEqual(
                self.client.post("/api/internal/shift-reminders").status_code, 401
            )
            self.assertEqual(self.request_reminder_at(before).json["reason"], "not_due")
            self.assertEqual(
                self.request_reminder_at(after).json, {"processed": True, "accepted": True}
            )
            for _ in range(2):
                self.assertEqual(self.request_reminder_at(after).json["reason"], "complete")
        send.assert_called_once()
        destination, body = send.call_args.args
        self.assertEqual(destination, "+18015551234")
        self.assertIn("2099-01-05", body)
        self.assertIn("11:45 AM-12:45 PM Utah time", body)
        self.assertIn("STOP", body)

    def test_reminder_failures_do_not_retry_or_lose_other_volunteers(self):
        self.add_reminder_entry("a-failed")
        self.add_reminder_entry("b-success")
        after = datetime(2099, 1, 4, 16, 0, tzinfo=ZoneInfo("America/Denver"))
        with patch.object(self.module, "twilio_sender_configured", return_value=True), patch.object(
            self.module, "send_twilio_sms", side_effect=[RuntimeError("Twilio rejected"), None]
        ), self.assertLogs(self.module.app.logger, level="ERROR"):
            self.assertEqual(self.request_reminder_at(after).json["accepted"], False)
            self.assertEqual(self.request_reminder_at(after).json["accepted"], True)
            self.assertEqual(self.request_reminder_at(after).json["reason"], "complete")
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(
                db.execute(
                    "SELECT signup_id, status FROM shift_reminder_attempts ORDER BY signup_id"
                ).fetchall(),
                [("a-failed", "failed"), ("b-success", "accepted")],
            )

    def test_reminders_are_uncapped_and_independent_of_admin_alert_limit(self):
        for index in range(12):
            self.add_reminder_entry(f"volunteer-{index}")
        after = datetime(2099, 1, 4, 16, 0, tzinfo=ZoneInfo("America/Denver"))
        with patch.object(self.module, "twilio_sender_configured", return_value=True), patch.object(
            self.module, "send_twilio_sms"
        ) as send:
            for _ in range(12):
                self.assertTrue(self.request_reminder_at(after).json["accepted"])
            self.assertEqual(self.request_reminder_at(after).json["reason"], "complete")
        self.assertEqual(send.call_count, 12)

    def test_reminder_missing_configuration_preserves_pending_signup(self):
        self.add_reminder_entry("pending")
        after = datetime(2099, 1, 4, 16, 0, tzinfo=ZoneInfo("America/Denver"))
        with self.assertLogs(self.module.app.logger, level="ERROR"):
            self.assertEqual(self.request_reminder_at(after).status_code, 503)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM shift_reminder_attempts").fetchone()[0], 0
            )

    def test_mountain_daylight_saving_reminder_schedule(self):
        for utc_hour, month, day in ((22, 7, 10), (23, 12, 10)):
            with self.subTest(month=month):
                with closing(sqlite3.connect(self.database)) as db, db:
                    db.execute("DELETE FROM entries")
                    db.execute("DELETE FROM shift_reminder_attempts")
                instant = datetime(2099, month, day, utc_hour, tzinfo=timezone.utc)
                local = instant.astimezone(ZoneInfo("America/Denver"))
                self.assertEqual(local.hour, 16)
                tomorrow = (local.date() + self.module.timedelta(days=1)).isoformat()
                self.add_reminder_entry("dst-entry", day=tomorrow)
                with patch.object(
                    self.module, "twilio_sender_configured", return_value=True
                ), patch.object(self.module, "send_twilio_sms"):
                    self.assertTrue(self.request_reminder_at(local).json["accepted"])

    def test_concurrent_reminder_calls_only_claim_signup_once(self):
        self.add_reminder_entry("concurrent")
        after = datetime(2099, 1, 4, 16, 0, tzinfo=ZoneInfo("America/Denver"))

        def send_request(_index):
            with self.app.test_client() as client:
                return client.post(
                    "/api/internal/shift-reminders", headers=self.reminder_headers
                ).json

        with patch.object(self.module, "datetime", wraps=datetime) as clock, patch.object(
            self.module, "twilio_sender_configured", return_value=True
        ), patch.object(self.module, "send_twilio_sms") as send:
            clock.now.return_value = after
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(send_request, range(2)))
        send.assert_called_once()
        self.assertEqual(sum(result["processed"] for result in results), 1)

    def test_deleted_signup_does_not_receive_reminder(self):
        self.add_reminder_entry("cancelled")
        self.login()
        self.assertEqual(
            self.client.delete("/api/entries/cancelled", headers=self.headers).status_code, 200
        )
        after = datetime(2099, 1, 4, 16, 0, tzinfo=ZoneInfo("America/Denver"))
        with patch.object(self.module, "send_twilio_sms") as send:
            self.assertEqual(self.request_reminder_at(after).json["reason"], "complete")
        send.assert_not_called()

    def test_childcare_signup_reminder_uses_its_scheduled_times(self):
        self.add_reminder_entry("childcare-reminder")
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute(
                "UPDATE entries SET type = 'childcare', start = '09:10', end = '10:10'"
            )
        after = datetime(2099, 1, 4, 16, 0, tzinfo=ZoneInfo("America/Denver"))
        with patch.object(self.module, "twilio_sender_configured", return_value=True), patch.object(
            self.module, "send_twilio_sms"
        ) as send:
            self.assertTrue(self.request_reminder_at(after).json["accepted"])
        self.assertIn("child care", send.call_args.args[1])
        self.assertIn("9:10 AM-10:10 AM", send.call_args.args[1])

    def test_migration_keeps_existing_contacts_and_defaults_to_no_consent(self):
        with tempfile.TemporaryDirectory(prefix="reminder-migration-") as directory:
            database = str(Path(directory) / "legacy.db")
            with closing(sqlite3.connect(database)) as db, db:
                db.execute(
                    """
                    CREATE TABLE entries (
                        id TEXT PRIMARY KEY, name TEXT, date TEXT, contact TEXT, notes TEXT,
                        start TEXT, end TEXT, type TEXT, need_id TEXT
                    )
                    """
                )
                db.execute(
                    "INSERT INTO entries (id, contact) VALUES ('legacy', 'legacy@example.invalid')"
                )
            with patch.object(self.module, "DATABASE_PATH", database):
                self.module.init_db()
                self.module.init_db()
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(
                    db.execute("SELECT contact, reminder_opt_in FROM entries").fetchall(),
                    [("legacy@example.invalid", 0)],
                )

    def test_signup_sms_is_sent_with_twilio_and_daily_cap(self):
        twilio_environment = {
            "TWILIO_ACCOUNT_SID": "AC123",
            "TWILIO_AUTH_TOKEN": "twilio-test-token",
            "TWILIO_FROM_NUMBER": "+18015550100",
            "SMS_ALERT_PHONE": "+18015550101",
        }
        with patch.dict(os.environ, twilio_environment), patch.object(
            self.module, "urlopen"
        ) as urlopen:
            urlopen.return_value.__enter__.return_value.status = 201
            for index in range(11):
                response = self.client.post(
                    "/api/entries", json={**self.entry, "name": f"Volunteer {index}"}
                )
                self.assertEqual(response.status_code, 200)

        self.assertEqual(urlopen.call_count, 10)
        request = urlopen.call_args.args[0]
        self.assertIn("/Accounts/AC123/Messages.json", request.full_url)
        self.assertIn(
            "Volunteer 9", parse_qs(request.data.decode())["Body"][0]
        )
        with closing(sqlite3.connect(self.database)) as db:
            attempts = db.execute(
                "SELECT status, COUNT(*) FROM sms_notification_attempts GROUP BY status"
            ).fetchall()
        self.assertEqual(attempts, [("sent", 10)])

    def test_signup_alert_failure_does_not_undo_signup(self):
        with patch.object(self.module, "twilio_sms_configured", return_value=True), patch.object(
            self.module, "send_signup_sms", side_effect=RuntimeError("Twilio unavailable")
        ), self.assertLogs(self.module.app.logger, level="ERROR"):
            response = self.client.post("/api/entries", json=self.entry)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.client.get("/api/entries").json), 1)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(
                db.execute("SELECT status FROM sms_notification_attempts").fetchall(),
                [("failed",)],
            )

    def test_disabled_sms_preserves_signups_without_consuming_attempts(self):
        self.add_reminder_entry("pending-disabled")
        with patch.dict(os.environ, {"SMS_ENABLED": "false"}), patch.object(
            self.module, "send_signup_sms"
        ) as alert, patch.object(self.module, "send_twilio_sms") as reminder:
            response = self.client.post("/api/entries", json=self.entry)
            self.assertEqual(response.status_code, 200)
            response = self.client.post(
                "/api/internal/shift-reminders", headers=self.reminder_headers
            )
            self.assertEqual(response.json, {"processed": False, "reason": "sms_disabled"})
            alert.assert_not_called()
            reminder.assert_not_called()
        with closing(sqlite3.connect(self.database)) as db:
            for table in ("sms_notification_attempts", "shift_reminder_attempts"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)

    def test_sms_is_disabled_by_default(self):
        with patch.dict(os.environ, clear=True):
            self.assertFalse(self.module.sms_enabled())
        with patch.dict(os.environ, {"SMS_ENABLED": "typo"}):
            with self.assertRaisesRegex(RuntimeError, "SMS_ENABLED"):
                self.module.sms_enabled()

    def test_signup_alert_targets_configured_number_not_volunteer_phone(self):
        environment = {
            "TWILIO_ACCOUNT_SID": "AC123",
            "TWILIO_AUTH_TOKEN": "twilio-test-token",
            "TWILIO_FROM_NUMBER": "+18015550100",
            "SMS_ALERT_PHONE": "+18015550101",
        }
        with patch.dict(os.environ, environment), patch.object(self.module, "urlopen") as opener:
            opener.return_value.__enter__.return_value.status = 201
            response = self.client.post("/api/entries", json=self.entry)
        self.assertEqual(response.status_code, 200)
        opener.assert_called_once()
        data = parse_qs(opener.call_args.args[0].data.decode())
        self.assertEqual(data["To"], ["+18015550101"])
        self.assertEqual(data["From"], ["+18015550100"])
        self.assertIn(self.entry["name"], data["Body"][0])
        self.assertIn(self.entry["date"], data["Body"][0])
        self.assertNotIn(self.entry["contact"], data["Body"][0])

    def test_invalid_entries_are_rejected_without_writes(self):
        cases = [
            {"date": "2099-02-30"}, {"date": "2099-1-05"}, {"date": "2000-01-01"},
            {"date": "2099-01-06"}, {"start": "24:00"}, {"end": "11:45"},
            {"start": "10:00"}, {"end": "18:00"}, {"start": "11:46"},
            {"type": "other"}, {"type": []}, {"name": " "},
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
        for url in ("/", "/project-info.html", "/privacy", "/terms", "/js/script.js", "/styles.css",
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

    def test_legal_pages_are_public_and_linked_from_signup(self):
        for url, heading, sections in (
            (
                "/privacy", "Privacy Policy",
                ("Information We Collect", "How We Use Your Information",
                 "SMS and Mobile Information", "Service Providers", "Data Security",
                 "Changes to This Policy", "Contact"),
            ),
            (
                "/terms", "Terms &amp; Conditions",
                ("Volunteer Signups", "SMS Volunteer Reminders", "Acceptable Use",
                 "Availability", "Privacy", "Changes to These Terms"),
            ),
        ):
            with self.subTest(url=url):
                response = self.client.get(url)
                self.addCleanup(response.close)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.mimetype, "text/html")
                html = response.get_data(as_text=True)
                self.assertIn(f"<h1>{heading}</h1>", html)
                self.assertIn("<strong>Joseph Anderson</strong>", html)
                for section in sections:
                    self.assertIn(f"<h2>{section}</h2>", html)
                self.assertIn('href="/project-info.html#questions"', html)
        with self.client.get("/") as response:
            signup = response.get_data(as_text=True)
        self.assertIn('href="/privacy"', signup)
        self.assertIn('href="/terms"', signup)

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
