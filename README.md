# House Help Volunteer Sign-Up Sheet

A simple sign-up sheet for volunteers helping with a house build project.

## Available volunteer windows

- Monday: 11:45 AM – 5:45 PM
- Wednesday: 11:45 AM – 5:45 PM
- Saturday: 8:30 AM – 2:00 PM

Volunteers can choose any start and end time within those hours.

## Run locally

Use the Flask app for the full server-backed experience:

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
