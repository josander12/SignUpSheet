# House Help Volunteer Sign-Up Sheet

A simple sign-up sheet for volunteers helping with a house build project.

## Available volunteer windows

- Monday: 11:45 AM – 5:45 PM
- Wednesday: 11:45 AM – 5:45 PM
- Saturday: 8:30 AM – 2:00 PM

Volunteers can choose any start and end time within those hours.

## Run locally

Use the Flask app for the full server-backed experience:

Install dependencies with `python -m pip install -r requirements.txt`. Create a
local `.env` file in the project folder with `FLASK_SECRET_KEY` and
`ADMIN_PASSWORD` set to your own secret values. The app loads this file at
startup; existing environment variables (including Render settings) take
precedence. The `.env` file is ignored by Git and must not be committed.

```bash
python app.py
```

Then open http://localhost:5000.

## Render deployment

This project is ready for a Render Web Service using the included configuration:

- [requirements.txt](requirements.txt)
- [gunicorn.conf.py](gunicorn.conf.py)
- [render.yaml](render.yaml)

Use the following start command in Render:

```bash
gunicorn --config gunicorn.conf.py app:app
```

> Gunicorn is designed for Linux environments; it will not run natively on a Windows desktop because it depends on Unix socket support via `fcntl`. Render runs on Linux, so the app is set up for that deployment target.
