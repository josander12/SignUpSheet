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

## JavaScript organization

The browser uses native ES modules in `js/`, with no frontend build step:

- `script.js`: initialization, event handlers, and signup flow.
- `state.js`: shared state and DOM references.
- `date-time.js`: date and time helpers.
- `data.js`: API requests, cached data, and volunteer availability.
- `views.js`: calendar and admin rendering, including shared view refreshes.

Use the Flask server rather than opening the HTML directly so module imports
and API requests work correctly.

Run the JavaScript regression tests with Node.js 18 or newer:

```bash
node --experimental-vm-modules --test tests/frontend.test.cjs
```

Run the backend regression tests (using an isolated temporary database):

```bash
python -m unittest discover -s tests -p test_app.py -v
```

## Validation and security

- The server assigns signup UUIDs and validates dates, times, volunteer type,
  required name/contact, and child care need references. General shifts use
  15-minute increments within Monday/Wednesday/Saturday windows. Child care
  shifts may use any minute within an existing need, matching the admin time
  inputs. Names are limited to 120 characters, contact to 254, and notes to 2000.
- Child care signup intervals cannot overlap for the same need. Adjacent and
  non-overlapping partial shifts are accepted by the API; general housebuilding
  shifts remain unlimited. The current signup form still books the whole child
  care need. A stale or conflicting booking returns HTTP 409 with a message to
  reload the calendar.
- Needs with volunteer signups cannot be deleted or rescheduled until those
  signups are removed; notes can still be edited. This applies to both direct
  deletion and the list-replacement API used by the admin UI. These checks and
  child care bookings use SQLite write transactions to prevent concurrent
  requests from overbooking or orphaning signups. Legacy child care entries
  without a need ID count toward overlapping needs on the same date, matching
  the calendar's coverage calculation. Existing bookings are not auto-deleted.
- All volunteer text and IDs interpolated into HTML are escaped, including
  legacy records. Only explicitly listed HTML, CSS, JavaScript, and icon assets
  are served; database/configuration files are not public assets.
- A same-origin Content Security Policy blocks inline scripts/styles, plugins,
  and framing. `X-Frame-Options: DENY` and a strict-origin-when-cross-origin
  referrer policy provide additional browser protections.
- Obtain a session CSRF token from `GET /api/admin-status` and send it as
  `X-CSRF-Token` for login, logout, and admin-changing requests. API responses
  use `Cache-Control: no-store`. Public signup creation does not require a
  session token, but applies the same validation and request-size limit.
- Five failed admin logins per IP in 15 minutes trigger HTTP 429. Attempts are
  stored in SQLite so separate requests/processes share the limit. `Retry-After`
  reports the seconds until the oldest failure expires. IPs rely on
  one trusted reverse proxy, as configured by `ProxyFix`; do not expose the
  production app directly behind an untrusted forwarded-header source.
- Cookies are explicitly HttpOnly and SameSite=Lax. Render sets
  `SESSION_COOKIE_SECURE=true`; set this for every HTTPS production deployment.
  Keep it unset/false for local HTTP development.
- Startup blocks calendar/signup interactions until session and data loading
  finish. Failed initialization offers Retry rather than enabling stale data.

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

Gunicorn uses one worker with two threads for this small SQLite-backed service.
SQLite uses WAL mode and a 30-second busy timeout to reduce write contention;
an exhausted lock wait returns HTTP 503 with an explicit retry message.

Production uses `DATABASE_PATH=/var/data/volunteer_app.db` on the persistent disk
configured in the Render dashboard and mounted at `/var/data`. Keep that disk
attached when changing or redeploying the service. SQLite's WAL and shared-memory
files are created alongside the database on the same disk.

The Blueprint sets the database path but does not provision the existing disk.
Its `plan: free` setting also does not match a disk-enabled service: before using
the Blueprint to create or synchronize a service, set the actual paid service
plan and configure the persistent disk. A database path alone does not provision
persistent storage.
