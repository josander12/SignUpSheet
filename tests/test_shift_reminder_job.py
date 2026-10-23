import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from urllib.error import HTTPError
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "reminder_job", Path(__file__).resolve().parents[1] / "scripts" / "send_shift_reminders.py"
)
reminder_job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reminder_job)


class ReminderJobTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(
            os.environ,
            {"SIGNUP_APP_URL": "https://signup.example.invalid", "REMINDER_JOB_TOKEN": "test"},
        )
        environment.start()
        self.addCleanup(environment.stop)

    def test_all_pending_reminders_are_processed(self):
        paths = []
        reminder_responses = iter(
            [
                {"processed": True, "accepted": True},
                {"processed": True, "accepted": True},
                {"processed": False, "reason": "complete"},
            ]
        )

        def respond(request, timeout):
            paths.append(request.full_url)
            response = io.BytesIO(json.dumps(next(reminder_responses)).encode())
            return response

        with patch.object(reminder_job, "urlopen", side_effect=respond), patch("builtins.print"):
            reminder_job.run_reminders()
        self.assertEqual(len(paths), 3)
        self.assertTrue(all(path.endswith("shift-reminders") for path in paths))

    def test_failed_reminder_is_reported_but_other_reminders_continue(self):
        responses = iter(
            [
                {"processed": True, "accepted": False},
                {"processed": True, "accepted": True},
                {"processed": False, "reason": "complete"},
            ]
        )

        def respond(request, timeout):
            return io.BytesIO(json.dumps(next(responses)).encode())

        with patch.object(reminder_job, "urlopen", side_effect=respond) as opener, patch(
            "builtins.print"
        ):
            with self.assertRaisesRegex(RuntimeError, "did not accept a volunteer reminder"):
                reminder_job.run_reminders()
        self.assertEqual(opener.call_count, 3)

    def test_request_failure_is_reported(self):
        error = HTTPError("https://signup.example.invalid", 503, "Unavailable", {}, None)
        with patch.object(reminder_job, "urlopen", side_effect=error), patch("builtins.print"):
            with self.assertRaisesRegex(RuntimeError, "Volunteer reminder request failed"):
                reminder_job.run_reminders()

    def test_missing_or_insecure_configuration_fails_before_network_request(self):
        for value in ("", "http://signup.example.invalid"):
            with self.subTest(url=value), patch.dict(
                os.environ, {"SIGNUP_APP_URL": value}
            ), patch.object(reminder_job, "urlopen") as opener:
                with self.assertRaisesRegex(RuntimeError, "HTTPS"):
                    reminder_job.run_reminders()
                opener.assert_not_called()


if __name__ == "__main__":
    unittest.main()
