import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def run_reminders():
    app_url = os.environ.get("SIGNUP_APP_URL", "").rstrip("/")
    token = os.environ.get("REMINDER_JOB_TOKEN", "")
    if not app_url.startswith("https://") or not token:
        raise RuntimeError("An HTTPS SIGNUP_APP_URL and REMINDER_JOB_TOKEN are required.")

    def request_job(path):
        request = Request(
            f"{app_url}/api/internal/{path}",
            data=b"",
            headers={"Authorization": "Bearer " + token},
            method="POST",
        )
        with urlopen(request, timeout=60) as response:
            result = json.load(response)
        print(f"{path}: {result}")
        return result

    errors = []
    try:
        while True:
            result = request_job("shift-reminders")
            if not result["processed"]:
                break
            if not result["accepted"]:
                errors.append("Twilio did not accept a volunteer reminder; check app logs.")
    except (HTTPError, URLError, TimeoutError) as error:
        print(f"Reminder request failed: {error}")
        errors.append("Volunteer reminder request failed.")

    if errors:
        raise RuntimeError("\n".join(errors))


if __name__ == "__main__":
    run_reminders()
