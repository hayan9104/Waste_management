# Safaai Sarathi 2.0 — Full System & Logic Reference

> Purpose of this document: a complete, code-verified map of what this product is, how every screen works, what data it shows, and what logic runs behind it — written so it can be handed to a design tool (e.g. Claude Design) to faithfully recreate or redesign the UI without losing any functional behavior. Every claim below was read directly from the source in `D:\Waste_management\Waste Management`, not inferred from the README marketing copy.

---

## 1. What the product is

**Safaai Sarathi 2.0** ("सफ़ाई सारथी") is a municipal solid-waste management platform for a city (seeded as Ahmedabad/Gandhinagar). It replaces a manual complaint dropbox with four isolated portals sharing one Postgres database:

| Portal | Role | Who uses it | Login |
|---|---|---|---|
| Citizen | `CITIZEN` | Residents reporting waste issues | Email/phone + password, or Google OAuth; self-signup |
| Driver | `DRIVER` | Collection-vehicle drivers | Phone OTP, or email+password with a first-login email PIN |
| Officer | `OFFICER` | Ward-level sanitation officers | Email + password, TOTP 2FA |
| Admin | `ADMIN` | Super admin / city command center | Email + password, TOTP 2FA |

Each portal is a **separate SPA shell** mounted under its own URL prefix (`/app`, `/driver`, `/officer`, `/admin`), with its own JWT audience, own login screen, and its own React Router subtree. There is no shared "switch role" UI.

Core idea: a citizen's photo report is run through an AI triage pipeline (classify → deduplicate → fraud-score → route) before a human ever sees it. Emergencies (medical waste, dead animals, sewage, fire) skip the queue and get a 30-minute SLA clock and immediate officer paging. Drivers get an auto-optimized multi-stop route; resolving a stop requires a photo of the cleaned site.

---

## 2. Repo layout

```
Waste Management/
├── backend/
│   ├── api/         Node/Express REST + Socket.io API (port 5100) — the core app
│   ├── ai/           Node/Express AI microservice (port 8100) — classify/fraud/hotspot stand-ins
│   └── vision/       Python FastAPI + Ultralytics YOLOv8 (port 8100 by default) — real vision model
└── frontend/         React 18 + TypeScript + Vite SPA (port 5273) — all 4 portals
```

Note: `backend/ai` and `backend/vision` both listen on 8100 by default and both expose classification — in practice one or the other is run. `backend/api`'s `ai.service.js` posts to `${AI_SERVICE_URL}/api/classify-waste`, which is the **vision** (Python/YOLO) service's route shape, not the Node AI service's route (`/vision/classify`). See §12.

---

## 3. Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite 6, React Router 6, TanStack Query 5, Tailwind CSS, Leaflet/React-Leaflet, Recharts, Three.js + @react-three/fiber (splash intro), Socket.io-client, Axios |
| Backend API | Node.js (ES modules), Express 4, Prisma ORM 6, PostgreSQL, Socket.io 4, Zod validation, Argon2id (`@node-rs/argon2`, scrypt fallback), JWT (`jsonwebtoken`), `otplib` (TOTP), Multer (uploads), Helmet, `express-rate-limit` (Redis-backed optionally) |
| AI microservice (Node) | Express, deterministic hash-based stand-ins + real heuristic fraud/hotspot math |
| Vision microservice (Python) | FastAPI + Ultralytics YOLOv8 (`safaai_best.pt` custom-trained weights) |
| Storage | Local disk (`api/uploads`) or Supabase Storage (`STORAGE_DRIVER=supabase`) |
| Realtime | Socket.io rooms: `ward:<id>`, `truck:<id>`, `user:<id>`, `complaint:<id>`, `city` |
| Routing engine | Built-in Node solver (nearest-neighbour → 2-opt → Or-opt) with OSRM public demo server for road-snapped polylines; optional external `ROUTING_SERVICE_URL` |
| i18n | Custom zero-dependency provider, 3 locales: English, Hindi (हिन्दी), Gujarati (ગુજરાતી) |

---

## 4. Architecture at a glance

```
Citizen / Driver / Officer / Admin SPA shells (one React app, 4 route trees)
        │  Axios client per portal, own localStorage token, own cookie-scoped refresh
        ▼
Express API (/api/*)
  ├─ requirePortal(portal) middleware — JWT audience check → 403 PORTAL_MISMATCH if wrong
  ├─ Route modules: auth / public / citizen / driver / officer / admin
  ├─ Services: complaint triage, escalation sweeper, routing solver, tracking ingest,
  │            analytics, notifications, chatbot, what-if simulator, vehicle simulator
  ├─ Socket.io gateway (rooms per ward/truck/user/complaint/city)
  └─ Prisma → PostgreSQL (17 tables)
        │
        ├─► AI microservice (classify / fraud / hotspot / duplicate-embedding)
        └─► OSRM public demo server (road-snapped polylines, nearest-road check)
```

Every spatial operation (point-in-ward, nearest, distance, bounding-box) is implemented in plain JS in `backend/api/src/lib/geo.js` because PostGIS isn't installed — the schema comment explicitly documents this as a temporary substitute with the same query shape PostGIS would use (bbox pre-filter + exact ray-cast).

---

## 5. Design system (for recreating the UI)

### 5.1 Color tokens (CSS variables, Tailwind-mapped, light/dark pair)

Semantic names only — components never read raw hex. Defined in `frontend/src/index.css`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--surface` | `247 247 245` (off-white) | `0 0 0` (true AMOLED black) | Page background |
| `--elevated` | `255 255 255` | `14 16 15` | Cards, headers, modals |
| `--sunken` | `238 239 235` | `8 9 8` | Inset panels, skeleton bg |
| `--line` | `223 224 219` | `38 42 39` | Borders |
| `--ink` | `0 0 0` (pure black) | `255 255 255` (pure white) | Primary text |
| `--muted` | slate `71 85 105` | slate `156 163 175` | Secondary text |
| `--faint` | `148 163 184` | `107 114 128` | Placeholder/disabled |
| `--brand` | green `21 128 61` | green `34 197 94` | Primary actions, citizen/officer accent |
| `--brand-soft` / `--brand-ink` | soft green bg / white | dark green bg / near-black | Brand tinted surfaces |
| `--warn` | amber `202 138 4` | amber `245 158 11` | Warnings, low-confidence |
| `--danger` | red `190 34 34` | red `248 81 73` | Emergencies, rejections, sign-out |
| `--info` | blue `29 100 168` | blue `56 160 255` | Verified/assigned status |
| `--ok` | green (=brand) | green | Resolved/success |

Admin portal uses an **orange accent** (`text-orange-600` / `bg-orange-600`) instead of brand green, everywhere the `accent="orange"` prop is passed to the shells and nav.

Theme toggle persists to `localStorage['ss_theme']` and toggles a `.dark` class on `<html>`. Dark mode is **true AMOLED black**, not dark grey — a deliberate design decision.

### 5.2 Typography & spacing conventions
- Fluid type scale classes: `text-fluid-xs/sm/base/lg/xl` (defined in Tailwind config, not shown here but referenced everywhere).
- `min-h-touch` / `w-touch` = a shared minimum tap-target size.
- Rounded corners are consistently large: `rounded-xl` (buttons/fields), `rounded-2xl` (cards), `rounded-3xl` (modals/hero elements).
- Cards: `.card` = `rounded-2xl border border-line bg-elevated shadow-card`.

### 5.3 Core reusable components (`components/ui.tsx`)
- **Badge/chip** — 6 tones (`neutral/info/warn/ok/danger/brand`), pill-shaped, border+bg+text all same hue at different opacities.
- **Card** — the universal container.
- **Stat** — KPI tile: label (uppercase, muted) + big bold number + optional hint + tone icon chip. Used across all dashboards.
- **Meter** — thin progress bar with % label; used for AI confidence and SLA countdown.
- **Modal** — bottom-sheet on mobile (`animate-sheet-up`, rounded top corners only), centered dialog on desktop (`sm:rounded-2xl`).
- **Toast system** — global singleton pusher (`toast.success/error/info/warn`), top-center on mobile / top-right on desktop, auto-dismiss ~4.2s, max 3 stacked.
- **DegradedNotice** — a specific amber banner shown whenever an API response has `degraded: true`, i.e. the AI service was unreachable and a fallback answered. This is a deliberate "never silently pretend the AI worked" pattern used throughout.
- **EmptyState / ErrorState / Loading / Skeleton** — standard empty/error/loading treatments.
- **LanguageSwitcher** — globe icon + dropdown, present in every shell header AND on auth screens (so a non-English reader can switch before logging in).
- **ThemeToggle** — sun/moon icon button.
- **Reveal** — IntersectionObserver-based scroll-in fade/slide, used on the landing page; degrades to instant-visible under `prefers-reduced-motion`.

### 5.4 Shell layouts (`components/shells.tsx`)
Two shell types, reused across all 4 portals:

**`MobileShell`** (Citizen, Driver) — mobile-app-like:
- Fixed top header (4rem + safe-area), logo + portal name/title, desktop shows a horizontal "SpotlightNav" pill bar (mouse-follow spotlight glow effect), mobile shows nothing in the header center.
- Bottom tab bar (`.tabbar`, hidden ≥ md) — up to 5 nav items with icon + label + optional numeric badge (red pill, "9+" cap).
- Account button top-right opens a centered/bottom-sheet **AccountModal**: avatar (photo or colored-initial circle), name, email/phone, role badge, "Edit Profile & Language" (citizen only), "Sign Out".
- Driver shell adds a GPS-sharing status pill in the header (green pulsing dot = live, amber = offline/queued, grey = paused) — tapping toggles broadcast on/off.

**`ConsoleShell`** (Officer, Admin) — desktop console:
- Same fixed header pattern but adds a hamburger button (< xl) opening a slide-in left drawer with the full nav list (icon + label + badge), and a full-width `SpotlightNav` bar on desktop (≥ xl) instead of a bottom tab bar.
- Subtitle line under the portal name (officer: ward name + code; admin: generic subtitle).
- Accent color switches the whole nav highlight from green (officer) to orange (admin).

### 5.5 Navigation maps (exact nav items per portal, in order)

**Citizen** (`/app/*`, bottom tabs, 5 shown + more via routes):
1. Home (`/app`) — icon Home
2. Report (`/app/report`) — icon PlusCircle
3. Schedule Event (`/app/schedule-pickup`) — icon Calendar
4. My Complaints (`/app/complaints`) — icon ListChecks
5. Rewards (`/app/rewards`) — icon Trophy
Additional routed-but-not-tabbed screens: Emergency Report (`/app/emergency`), Scheduled Requests list (`/app/scheduled-requests`), Complaint Detail (`/app/complaints/:id`), Track Truck (`/app/track/:id`), Directory (`/app/directory`), Profile (`/app/profile`).

**Driver** (`/driver/*`, 5 tabs):
1. Route (`/driver`) — icon Map
2. Stops (`/driver/stops`) — icon ListChecks
3. Fuel Log (`/driver/fuel`) — icon Fuel
4. Shift Summary (`/driver/summary`) — icon BarChart3
5. SOS (`/driver/sos`) — icon Siren

**Officer** (`/officer/*`, 7 nav items in a console bar, badges on Queue & Emergencies):
1. Dashboard (`/officer`) — LayoutDashboard
2. Queue (`/officer/queue`) — ListFilter, badge = `reviewNeeded` count
3. Schedule (`/officer/scheduled-requests`) — Calendar
4. Emergencies (`/officer/emergencies`) — Siren, badge = `emergenciesOpen` count
5. Hotspots (`/officer/hotspots`) — TrendingUp
6. Fleet (`/officer/fleet`) — Truck
7. Analytics (`/officer/analytics`) — BarChart3
(Escalations screen exists and is routed at `/officer/escalations` but is **not** in the nav bar — URL-only.)

**Admin** (`/admin/*`, 7 nav items, orange accent):
1. Dashboard (`/admin`) — LayoutDashboard
2. Fleet (`/admin/fleet`) — Truck
3. Users (`/admin/users`) — Users
4. Analytics (`/admin/analytics`) — BarChart3
5. Compliance (`/admin/compliance`) — FileDown
6. Audit (`/admin/audit`) — ScrollText
7. Wards (`/admin/wards`) — MapPinned
(`/ai.health` exists as an admin-gated URL-only page, deliberately removed from the tab bar.)

### 5.6 Auth/landing screens
- **Splash** (`/`, first load only) — **correction**: despite `three`/`@react-three/fiber` being listed in `package.json` and the README marketing a "3D drive-by truck intro," the actual `Splash.tsx` component is a plain 2D CSS/image splash (blurred Ken-Burns background photo + animated text). A repo-wide grep for `@react-three|three` usage found none outside README/locale copy — the 3D intro was either removed or never wired up. Replays on every fresh tab/hard-refresh (not session-gated), ~2.5s.
- **Landing** — public marketing/stat page: tricolor (🇮🇳 saffron/white/green) top strip that fades on scroll into a floating pill nav; live counters (animated count-up, cubic ease-out) fed by `GET /public/stats`; "how it works" 4-step flow; differentiators; citizen-features grid; FAQ accordion; portal login CTAs.
- **Login** — shared component parameterized by `portal` prop, renders the right branding/fields per portal (citizen: email/phone/password/Google button; driver: OTP or password path; officer/admin: password + TOTP challenge step).
- **Register** — citizen self-signup only (name, email, phone optional, password, language picker).
- **BootLoader** — brief branded spinner shown on every hard refresh of any non-root route (550ms minimum), separate from the splash.

---

## 6. Screen-by-screen: what each page shows and does

### 6.1 Citizen portal

| Screen | Backend endpoint(s) | What it does |
|---|---|---|
| **Home** | `GET /citizen/home` | Greeting, ward name, green-credit balance, active-complaint count, resolved count, up to 5 active complaints, and — if one has an assigned vehicle with a GPS fix — a live "truck heading your way" card with distance and ETA (20 km/h average-speed estimate). |
| **New Report** | photo classify + `POST /citizen/report` (or the mismatched `/citizen/classify-waste` + `/citizen/complaints` calls — see §12) | 3-step wizard: **(1) Capture** — camera/file input, client-side canvas compression to ≤1200px JPEG @0.82 quality before upload; **(2) AI Review** — uploads photo, shows a "YOLOv8 scanning" overlay, displays predicted category + confidence %, lets the citizen confirm/override any of 9 categories (each with icon, description, and an "🚨 30m SLA" badge on the 4 emergency-eligible categories), optional free-text landmark note; **(3) Location** — draggable Leaflet pin (auto-centered on GPS, falls back to IP geolocation, then to a hardcoded Gandhinagar coordinate), duplicate-nearby check as the pin moves, summary card, "+20 Green Credits" perk note, submit button. |
| **Emergency Report** | `POST /citizen/emergency` | The "red button" — a reduced flow restricted to the 4 emergency categories (dead animal, medical waste, burning waste, sewage overflow); always creates a `CRITICAL` severity, `isEmergency: true` complaint with a short SLA (120–240 min) and bypasses the normal auto-verify gate to page officers immediately. |
| **My Complaints** | `GET /citizen/complaints` | List of the citizen's own reports, filterable by status, each showing category, status badge (color-coded per §5.1), thumbnail, age. |
| **Complaint Detail** | `GET /citizen/complaints/:id` | Full record: photo, AI category/confidence, status timeline (`PENDING → VERIFIED → ASSIGNED → IN_PROGRESS → RESOLVED`, or `REJECTED`), resolution photo once resolved, assigned vehicle mini-card with live distance/ETA if dispatched. |
| **Track Truck** | `GET /citizen/complaints/:id/track` + Socket room `truck:<vehicleId>` | Live Leaflet map: OSRM-drawn real road route from the truck's current position to the complaint pin, truck marker rotated to heading and smoothly interpolated via socket pushes, distance + ETA readout. Handles "not dispatched yet" and "no GPS fix yet" states explicitly. |
| **Rewards** | `GET /citizen/credits`, `POST /citizen/rewards/redeem` | Green Credits wallet balance + transaction history ledger; a rewards catalog (vouchers) the citizen can redeem if balance ≥ cost — deducts credits, generates a voucher code (`SS-<CATEGORY>-XXXXX-2026`), records both a `GreenCredit` ledger row and an `AuditLog` row. |
| **Leaderboard** (surfaced inside Rewards or a related screen) | `GET /citizen/leaderboard` | Ward or city-wide top-10 by green credits; other users' names are partially masked (`First L.`) except the viewer's own row. |
| **Schedule Pickup** | `POST /citizen/scheduled-pickup` | Advance-notice bulk/event pickup request form: location type (home vs. society/common plot), address, expected waste categories (multi-select) + quantity (S/M/L), target date + time slot (morning/afternoon/evening), notes. Enforces **≥20 hours lead time** (comment says 24h, code checks `hoursAhead < 20`). Notifies the citizen and every officer on the resolved ward. |
| **My Scheduled Requests** | `GET /citizen/scheduled-pickup`, `GET /citizen/scheduled-pickup/:id`, `POST /citizen/scheduled-pickup/:id/cancel` | List/detail/cancel for the citizen's own scheduled pickups; shows status (`PENDING_REVIEW → APPROVED_SCHEDULED → ASSIGNED → IN_PROGRESS → COMPLETED`, or `REJECTED`/`CANCELLED`), assigned driver/vehicle once set, completion photo once done. Cancel is only allowed pre-completion. |
| **Directory** | `GET /citizen/directory` | Offline-cacheable emergency contacts list (sanitation control room, fire, ambulance, police, animal control, pest control), filtered to city-wide + the citizen's own ward. |
| **Profile** | `PATCH /citizen/profile`, `POST /citizen/profile/avatar` | Edit name, language (en/hi/gu), ward; upload a profile photo (same upload pipeline as complaint photos). |
| **Chatbot widget** (floating, every page) | `POST /citizen/chatbot` (authenticated) or `POST /public/chatbot` (anonymous) | "AI Safaai Sahayak" — see §7.10. |

### 6.2 Driver portal

| Screen | Backend endpoint(s) | What it does |
|---|---|---|
| **Route** (home tab) | `GET /driver/route` (aka `/driver/shift`) | Today's published route: ordered stop list with sequence numbers, road-snapped polyline (with per-stop `polylineIndex` so the traveled portion can be visually "consumed" as the driver moves), progress (`done`/`total`), next unfinished stop highlighted, live vehicle marker via `truck:<id>` socket room. Background: `useLocationBroadcast` hook watches `navigator.geolocation`, throttles to one emit per 3s, sends over the socket when online, queues (max 500 points) and flushes via `POST /driver/location/batch` when connectivity returns — full offline-tolerant GPS sync. |
| **Stops** | `GET /driver/tasks?status=`, `POST /driver/tasks/:id/start`, `POST /driver/tasks/:id/complete`, `POST /driver/stops/:seq/skip` | Task list filterable by pending/in-progress/completed/all, each with distance-from-current-position. "Start" transitions a complaint to `IN_PROGRESS`. **"Complete" requires a photo** (camera capture or upload) of the cleaned site — the API rejects resolution without one; this is the "mandatory photo-proof" feature the README calls out. Completing also updates the day's `Route.orderedStops` JSON and marks the route `COMPLETED` once every stop is done, and broadcasts the update to the officer/citizen. Skip records a reason and marks the stop `SKIPPED` without resolving it. |
| **Fuel Log** | `POST /driver/fuel-log`, `GET /driver/fuel-log` | Logs liters, odometer reading (only updates the vehicle's odometer if higher than stored), cost, notes, and an optional receipt photo. |
| **Shift Summary** | `GET /driver/shift-summary` (aka `/driver/summary`) | End-of-day recap: stops done/total/skipped, resolved list, distance driven (from actual GPS ping history, not the planned route), planned vs actual km, fuel logged today, minutes on route, and the raw GPS trail for a replay map. |
| **SOS** | `POST /driver/sos` | One-tap emergency button: reason + optional message + current GPS. Creates a `SosAlert` row, broadcasts to the ward's officers + city room over sockets, and pushes an in-app `EMERGENCY` notification to every officer scoped to that ward. |
| **Scheduled Tasks** (reachable via assignment notifications, not a main tab) | `GET /driver/scheduled-tasks`, `POST /driver/scheduled-tasks/:id/complete` | Advance-booked pickups assigned to this driver; completing one requires a photo, awards the citizen +25 Green Credits, and notifies them. |

### 6.3 Officer portal

| Screen | Backend endpoint(s) | What it does |
|---|---|---|
| **Dashboard** | `GET /officer/dashboard` (aka `/overview`) | Ward-scoped KPI row: SLA compliance %, active trucks, pending complaints, today-resolved count, plus a status breakdown and 7-day category breakdown. Ward heatmap + fleet map are also driven from `/officer/wards`, `/officer/heatmap`, `/officer/fleet` queries fired from this screen. |
| **Complaint Queue** | `GET /officer/queue` (aka `/complaints`) | The core triage table — dense sortable/filterable table on desktop, stacked cards on mobile. Filters: status (with special aliases `ai_verifying`→PENDING, `verified`→VERIFIED, `flagged`→REJECTED), min AI confidence, category, severity, ward, "review needed" flag, emergency flag, overdue flag, free-text search (code or address), sort (newest/oldest/severity/confidence/due), pagination. Each row shows AI confidence + a "low confidence" flag (<70%) and an SLA countdown. Row actions: **Verify** (`POST .../verify` with decision VERIFIED/REJECTED), **Reject/flag false-positive** (`ALL .../reject`), **Assign** to a driver/vehicle (single or bulk, `POST /officer/assign`), **Escalate**. |
| **Complaint Detail** | `GET /officer/complaints/:id` | Full record + timeline with actor name/role on each event, escalation history, and linked duplicate reports (with similarity score + distance), assigned driver contact. |
| **Scheduled Requests** | `GET /officer/scheduled-requests`, `.../approve`, `.../reject`, `.../assign` | Ward's advance-pickup request queue: approve (notifies citizen), reject with a required reason (notifies citizen), or assign a driver + vehicle (notifies both citizen and driver, plus a `new_task_assigned` socket push to the driver). |
| **Emergencies** | `GET /officer/emergencies`, `.../ack` | Three-way merged feed: SLA-breached complaints, citizen-flagged emergency complaints, and unresolved driver SOS alerts — each type carries a `type` tag for the UI to badge differently. Acknowledge works on either a SOS alert or a complaint. |
| **Hotspots** | `GET /officer/hotspots` (aka `/heatmap`) | Leaflet heatmap of complaint density (weighted: emergencies ×3, +upvotes) plus a forward-looking risk forecast per ward for tomorrow (or a requested date). |
| **Fleet** | `GET /officer/fleet` | Live vehicle list scoped to the officer's ward(s): status, driver, current/active task count, "stale" flag if no ping in >120s. |
| **Analytics** | `GET /officer/analytics` | Trend line (reported/resolved/emergencies/SLA% per day), category breakdown, per-ward performance, status breakdown, and a fuel-usage rollup (total liters/cost, recent log entries). |
| **Escalations** (URL-only, not tabbed) | `GET /officer/escalations` | Escalation event history for the ward, with target officer/admin and reason. |
| **What-If Simulator** (embedded, likely on Dashboard/Hotspots) | `POST /officer/simulate` | "If we delay collection by N hours, what happens?" — see §7.7. |
| **Recommendation cards** (embedded on Dashboard) | `GET /officer/recommendations` | Rule-generated action cards: high-density area alert (≥3 reports/7d at one address → suggest a secondary bin/sweep), overdue-complaints alert, recurring-category pattern alert. |
| **Route optimize/publish** (part of an assignment flow, likely inside Fleet or Queue) | `POST /officer/routes/optimize`, `POST /officer/routes/publish` | Solves and previews a route for a vehicle from a set of complaints, then publishing writes the `Route` row, reassigns those complaints to `ASSIGNED`, and notifies the driver. |
| **Add Driver** (likely inside Fleet) | `POST /officer/drivers` | Officers can provision driver accounts scoped to their own ward(s) only. |

### 6.4 Admin portal

| Screen | Backend endpoint(s) | What it does |
|---|---|---|
| **Dashboard** | `GET /admin/dashboard` (aka `/overview`) | City-wide KPIs (no ward scoping — `wardIds=null` everywhere), ward performance table, status/category breakdowns, staff counts (active officers/drivers, total citizens). |
| **Master Fleet** | `GET /admin/fleet`, `POST /admin/fleet`, `PATCH /admin/fleet/:id`, `GET /admin/fleet/:id/route` | Full vehicle registry across every ward, with online/stale status; create/edit vehicles (registration, ward, driver, model, capacity, maintenance flag, status); per-vehicle route+trail detail view showing both the planned route polyline and the actual GPS breadcrumb trail. |
| **User Management** | `GET/POST/PATCH /admin/users`, `.../block` | City-wide user directory (searchable, filterable by role/ward, paginated); create driver/officer/admin accounts (officers can be given multiple `wardIds`, first one flagged primary); edit role/ward/active/password; **block/unblock** instantly revokes all of that user's refresh-token sessions and writes an audit log; an admin cannot block or deactivate themself. |
| **City Analytics** | `GET /admin/analytics` | Same shape as officer analytics but unscoped (whole city). |
| **Compliance Export** | `GET /admin/exports` (aka `/export/compliance`), CSV via `?format=csv` | Per-ward compliance summary (reported/resolved/open/emergencies/SLA%/avg resolution time/vehicles) with city totals, downloadable as CSV or JSON, plus trend/category data. |
| **Audit Log** | `GET /admin/audit-logs` (aka `/audit`) | Searchable/paginated immutable log of every privileged action (assignment, verification, rejection, escalation, user block/update, ward changes, route publish, reward redemption, etc.) with actor, before/after JSON, IP, user-agent. |
| **Ward Settings** | `GET/POST/PATCH /admin/wards` | Ward CRUD: name, code, zone, population, SLA minutes, and a GeoJSON polygon boundary editor — saving recomputes the stored bounding box + centroid server-side. |
| **Model Health** | `GET /admin/model-health` | Per-model status dashboard: vision classifier / hotspot engine (reachability tied to the same FastAPI service — degrade together), route solver (always "ACTIVE", runs in-process), what-if simulator (always "ACTIVE"), chatbot (engine label switches between `groq-llm` and `rule-based-fallback` depending on whether `GROQ_API_KEY` is set). Shows daily sample counts, average confidence, false-positive rate (rejected/total over the window), and calibration parameters pulled from `config/calibration/*.json`. |
| **Re-seed demo data** (likely a button on Dashboard or a settings area) | `POST /admin/reseed-demo-data` | Fires the full deterministic seed script in the background (wipes + rebuilds city/wards/fleet/45-day history); responds immediately since a full reseed with live OSRM road-snapping per route can take minutes. |
| **AI Health** (URL-only, `/ai.health`) | uses `aiHealth()` under the hood | Standalone reachability/status page for the AI microservice, deliberately kept out of the main tab bar. |

---

## 7. Core business logic (the "small logic" detail)

### 7.1 Authentication & portal isolation

- **Four independent login endpoints**, not one shared screen with a role dropdown: `POST /auth/citizen/login`, `/auth/driver/login`, `/auth/officer/login`, `/auth/admin/login`. Each enforces `expectedRole` at the point of token issuance — so hitting the officer endpoint with valid citizen credentials still fails, before any route guard even runs.
- **Password hashing**: Argon2id via `@node-rs/argon2` (memoryCost 19456 KiB, timeCost 2, parallelism 1 — OWASP minimum), with an automatic fallback to Node's built-in `scrypt` (N=16384, r=8, p=1) if the native module can't load. The active driver is reported at boot and via `/api/health`.
- **Access tokens**: JWT, 15-minute default TTL, signed claims `{ sub, role, name, wardId, portal }`, `aud` = the portal string, `iss = 'safaai-sarathi'`. Every protected route runs `requirePortal(portal)` which decodes the token and rejects with `403 PORTAL_MISMATCH` if `aud`/`portal` doesn't match the namespace being called — the one exception being an `ADMIN` token is allowed into the `officer` namespace (city-wide oversight).
- **Refresh tokens**: opaque random 48-byte tokens, **only the SHA-256 hash is stored** in `refresh_tokens`, delivered as an `httpOnly`, `path=/api/auth`-scoped cookie (`ss_refresh`). `SameSite` is `strict` in dev and forced to `none`+`Secure` in prod (cross-site Vercel↔Render deploy requires it). **Rotation on every use**: `POST /auth/refresh` issues a new token and marks the old row `revokedAt` + `replacedById`. **Reuse detection**: if a client presents an already-revoked refresh token (a stolen/replayed token), the entire token family for that user is revoked immediately and the request is rejected — this is logged as an audit event (`refresh_token_reuse_detected`).
- **2FA (Officer/Admin)**: TOTP via `otplib`, no third-party auth SaaS. Login with a 2FA-enabled account returns a short-lived (5 min) `challengeToken` instead of a session; `POST /auth/2fa/verify` exchanges `{challengeToken, code}` for the real session. Setup flow: `POST /auth/2fa/setup` generates a secret + `otpauthUrl` (for a QR code), `POST /auth/2fa/confirm` verifies one code before flipping `twoFactorEnabled`.
- **Driver phone OTP**: `POST /auth/driver/otp/request` (rate-limited 5/10min) never reveals whether a phone number belongs to a driver — always responds `{sent:true}`; the 6-digit code is hashed and stored with a 5-minute expiry and a 5-attempt cap, logged to the console (no SMS gateway wired). `POST /auth/driver/otp/verify` completes login.
- **Driver first-login email PIN**: a driver logging in with email+password for the first time (no `emailVerifiedAt`) is intercepted mid-login — instead of a session, a 6-digit PIN is emailed and `POST /auth/driver/first-login-verify` must be completed once to both verify the email and get a session.
- **Google OAuth (citizen only)**: standard authorization-code flow (`GET /auth/citizen/google` → redirect → `GET /auth/citizen/google/callback`) with a server-held one-time `state` map (10-min TTL), plus a native/SDK path (`POST /auth/citizen/google/token` with a pre-verified ID token). New Google sign-ins link to an existing password account by matching verified email before creating a new user.
- **Password reset**: always responds `{sent:true}` regardless of whether the email exists (no user enumeration); reset consumes a hashed, single-use, 2-hour token and revokes **all** existing refresh sessions for that user.
- **Client-side mirror**: one Axios instance per portal (`api('citizen')`, `api('driver')`, …), each with its own `localStorage` token key so multiple portal sessions can coexist in one browser tab without collision. A 401 triggers a single shared in-flight refresh (deduped across concurrent requests) before retrying the original call; a `403 PORTAL_MISMATCH` clears that portal's token immediately without retry.

### 7.2 Complaint triage pipeline (`createComplaint`, `backend/api/src/services/complaint.service.js`)

Runs synchronously on every citizen photo report, in this order:

1. **Reachability check** — calls OSRM's `nearest` API for the pinned coordinate; if the nearest road is >300m away, the report is rejected outright with a message telling the citizen to move the pin (never blocks if OSRM itself is unreachable — that's treated as a service outage, not evidence the spot is unreachable).
2. **Classify** — if a photo buffer is present, calls the AI service's `/api/classify-waste`; on any failure, falls back to a **deterministic local classifier** (SHA-256 digest of the image bytes selects a category and a confidence deliberately kept below the auto-approve threshold) so the same photo always yields the same fallback result.
3. **Category resolution** — if AI confidence ≥ `AI_CONFIDENCE_AUTO_APPROVE` (default 0.7), the AI category wins; otherwise the **citizen's own declared category wins** — the model is explicitly documented as an assistant, not an authority, when unsure.
4. **Ward attribution** — bounding-box SQL pre-filter over all wards, then an exact ray-cast point-in-polygon test in JS (`wardForPoint`).
5. **Fraud scoring** — builds features (account age, reports in the last hour, historical rejection rate, EXIF/blur signals) and calls the fraud model (see §7.4).
6. **Duplicate detection** (see §7.3).
7. **Persist** — SLA minutes = 30 (emergency) or the category's configured default (see table below); `dueAt = now + slaMinutes`; status is `VERIFIED` immediately if auto-approved and not a duplicate, else `PENDING`.
8. **Duplicate bookkeeping** — if a duplicate was found, links the new report to the parent via `ComplaintDuplicate` and increments the parent's `upvotes`.
9. **Green Credits** — awards +2 (duplicate/confirmation), +25 (emergency), or +5 (normal report) immediately on submission.
10. **Fan-out** — emits `complaint:new` or `emergency:new` over sockets to the ward room + city room; if emergency, pages every officer scoped to that ward (bypassing the normal queue) via in-app notification; always notifies the citizen of the outcome.

**Category → default severity/SLA/emergency table** (`config/constants.js`):

| Category | Emergency? | Severity | Default SLA |
|---|---|---|---|
| Garbage pile | No | Medium | 1440 min (24h) |
| Overflowing bin | No | Medium | 720 min (12h) |
| Dead animal | **Yes** | Critical | 120 min (2h) |
| Construction debris | No | Low | 2880 min (48h) |
| Medical waste | **Yes** | Critical | 120 min (2h) |
| Illegal dumping | No | High | 720 min (12h) |
| Sewage overflow | **Yes** | High | 240 min (4h) |
| Burning waste | **Yes** | High | 120 min (2h) |
| Other | No | Low | 2880 min (48h) |

Any complaint flagged `isEmergency` gets its SLA overridden to `ESCALATION_EMERGENCY_MINUTES` (default 30) regardless of category default, and severity forced to `CRITICAL`.

### 7.3 Duplicate detection

Geo + category + recency signal (the "CLIP embedding" the README mentions is designed to fold in via the AI service but the load-bearing logic here is computed from data the API definitely has):

- Candidate pool: same category, not resolved/rejected, not already a duplicate itself, created within the last **24 hours**, inside a **60-metre** bounding box of the new report, optionally same ward.
- For each candidate: `proximity = 1 - distanceMeters/60`, `recency = 1 - min(1, ageHours/24)`, `similarity = 0.65×proximity + 0.2 (fixed category-match weight) + 0.15×recency`.
- Merges only if `similarity ≥ 0.72` and the candidate is outside the 60m radius disqualifies it entirely (hard cutoff before the score is even used).
- On resolution of the parent, **every duplicate is auto-resolved too** and its citizen is notified — "everyone who reported the same thing hears it was fixed."

### 7.4 Fraud/anomaly scoring

Two layers, always real math (not a stub) even though the *inputs* about image quality are heuristic:

- **API-side rule heuristic** (`localFraudScore`, used when the AI service is unreachable): starts at 0.05, adds 0.45 for an exact duplicate photo hash, 0.25 for >3 rapid submissions in the same ward within 5 minutes, 0.15 for reporting far outside the citizen's own ward, 0.05 for missing EXIF — capped at 0.99, flagged at ≥0.6.
- **AI-service logistic model** (`fraudScore` in `backend/ai/src/models.js`): a genuine logistic regression `1/(1+e^-z)` over hand-set (not trained) weights — new account (<2h old, +1.3), burst reporting (>5/hr, +1.6), high prior-rejection rate (>35%, +2.1), no EXIF (+0.7), low image detail/blur (+0.9), screenshot-like aspect ratio (+0.6), far from the citizen's usual ward (+0.5) — intercept -2.4. Verdict bands: `review` ≥0.6, `watch` ≥0.35, else `ok`.
- Image-quality features that feed both are **genuinely measured from the raw bytes** (`backend/ai/src/imageFeatures.js`), with zero native image-processing dependency: JPEG/PNG/WebP dimensions parsed from file headers, EXIF presence + camera make/model/GPS-tag/orientation parsed from the JPEG APP1 segment, Shannon entropy over a byte histogram (photographic detail vs. flat/re-compressed), and a bytes-per-pixel "detail density" proxy for blur.
- A complaint is flagged `reviewNeeded` if either the AI confidence is below the auto-approve gate **or** the fraud score is ≥ `AI_FRAUD_REVIEW_THRESHOLD` (default 0.6).

### 7.5 Escalation / SLA enforcement

A 60-second interval sweep (`escalation.service.js`), not a per-complaint timer, so a server restart never silently drops a pending escalation:

- **Level 1**: any open complaint (`PENDING/VERIFIED/ASSIGNED/IN_PROGRESS`) past its `dueAt` → escalates to the ward's primary officer (falls back to any officer on that ward, then to nobody with a ward-wide broadcast instead).
- **Level 2**: still open at **2× its original SLA window** → escalates to the oldest active `ADMIN` account, and severity is forced to `CRITICAL`.
- Max 2 escalation levels per complaint (`escalationCount < 2` guard). Each escalation writes an `Escalation` row, bumps `escalationCount`, and fans out a socket event + notification.
- `slaCountdown(complaint)` (used to render the officer's countdown UI) computes minutes left, whether it's already overdue, and a 0–100% "time elapsed" bar.

### 7.6 Route optimization (VRP solver)

Pure in-process solver, no external dependency required (`routing.service.js`), designed to "re-solve live in front of judges":

1. **Baseline** — cost of visiting stops in the order they were reported (what "no AI" would look like), used to compute the savings claim shown in the UI.
2. **Nearest-neighbour construction** — emergency stops are walked first as their own greedy sub-tour, then normal stops are appended, starting from wherever the emergency sub-tour ended. Emergencies are thus always visited first, unconditionally.
3. **2-opt refinement** — repeated edge-reversal swaps over the *non-emergency tail only* (emergency stops are locked at the head and excluded from reordering), capped at 60 iterations, applied whenever a swap improves total distance.
4. **Or-opt refinement** — single-stop relocation (remove one stop, reinsert elsewhere) over the same non-emergency tail, capped at 40 iterations.
5. **Scheduling** — walks the final order from a `startTime` (default 07:00), converts each leg's road-km to minutes at a calibrated average truck speed, adds a per-stop service time, producing an ETA string per stop.
6. **Reported metrics**: `distanceKm`, `baselineKm`, `savedKm`/`savedPct`, `durationMin`, `fuelSaved` (₹, at 5.5 km/L and ₹96/L), `co2SavedKg` (2.68 kg CO₂/L).
7. Road distance uses a fixed **1.32× detour factor** over straight-line distance (documented as typical for Indian city grids) unless an external `ROUTING_SERVICE_URL` (OSRM/OR-Tools) is configured, in which case that's used instead.
8. **Road-snapped polylines**: after solving, the ordered waypoints are sent to the public OSRM demo server to get real street-following geometry; if OSRM is unreachable, falls back to an "L-shaped" zigzag approximation (alternating corner direction) so the drawn line still reads as street movement rather than a diagonal line through buildings. A self-healing function (`ensureRoadSnappedPolyline`) detects routes that only ever got the degenerate fallback shape stored and regenerates+persists real geometry the next time they're read.

### 7.7 What-if collection simulator (Officer "Simulate" feature)

A genuine **Poisson–Markov Monte Carlo simulation** (`whatif.service.js`), not a fixed formula:

- Ward "fill level" modeled as a 4-state Markov chain (`optimal → filling → near_full → overflow`), starting state chosen from the ward's recent report rate relative to 2× the citywide calibrated baseline (a proxy, since there's no real IoT bin-fill sensor data yet).
- For each of `RUNS` (calibration-configured) Monte Carlo runs, walks the chain one day at a time for `round(delayHours/24)` days, drawing a Poisson-distributed report count per day (Knuth's algorithm) from a lambda derived from the ward's actual report rate.
- Outputs: probability the ward ends in `overflow`, probability it's `near_full`-or-worse, expected additional reports, and a derived SLA-penalty risk band (HIGH/MEDIUM/LOW) plus immediate-vs-delayed-dispatch CO₂ impact estimates.

### 7.8 Hotspot forecasting

Two layers, always labeled honestly as to which ran:

- **Preferred**: calls the AI service's `/hotspot/predict`, which does a seasonal-naive forecast — same-weekday history over the last ~60 days, exponentially recency-weighted (half-life ~21 days), blended 60/40 with the last-7-day mean, plus a trend term — genuinely computed, explicitly labeled `engine: seasonal-baseline` (not claiming to be the LightGBM model the README markets).
- **Fallback** (AI service unreachable): an equivalent seasonal-naive baseline computed directly in the API (`analytics.service.js`), labeled `modelVersion: baseline-seasonal-v1`, `source: api-fallback`.
- Predictions are always persisted to `HotspotPrediction` (upserted per ward+date) regardless of which engine produced them.

### 7.9 Live GPS tracking

- One ingest path for both the driver app's socket emit and the REST fallback (`tracking.service.service` / `ingestLocation`).
- History rows (`VehicleLocation`) are throttled to at most one write per 3 seconds **and** only if the vehicle moved ≥8 metres, to keep the table from exploding during a live demo — the denormalized "last known position" on `Vehicle` is updated on every single ping regardless.
- Every ping snaps the vehicle's live position onto the day's published route polyline (closest-point-on-segment projection) to compute a `routeProgress` percentage and how far off-route it currently is — this drives the "traversed vs. remaining" line coloring on maps.
- Broadcasts `truck:update` to three rooms at once: the ward room, the city room, and the specific truck room — so a citizen tracking one delivery only ever subscribes to the single truck room, keeping payload size independent of fleet size.
- **Demo vehicle simulator** (`simulator.js`, `SIMULATOR_ENABLED=true` by default): re-syncs every ~30 ticks against today's published routes, walks each truck along its polyline at a fixed 24 km/h, interpolating position/heading between waypoints, and feeds every step through the exact same `ingestLocation` function a real driver phone would call — "nothing about the architecture is shortcut for the demo."

### 7.10 Notifications & Green Credits

- `notify()` writes a `Notification` row and emits `notification:new` to the user's personal socket room (`user:<id>`); external push (Expo/Web Push) is a documented stub that just logs in non-production.
- `notifyWardOfficers(wardId, ...)` fans out to every officer scoped to that ward **plus every active admin** (so nothing municipal ever goes unseen).
- `awardCredits()` atomically increments `User.greenCredits` and appends an immutable `GreenCredit` ledger row with `balanceAfter` snapshotted — never a bare delta with no audit trail.
- **Green Credit rule table** (`CREDIT_RULES`, version `credits-v1`): report submitted +5, report verified +15, report resolved +10, emergency verified +25, duplicate/confirming report +2, fake/rejected report **−20** (a real penalty, not just zero).

### 7.11 Chatbot ("AI Safaai Sahayak")

- Available unauthenticated (`/public/chatbot`, rate-limited 20/10min — "what stands between it and abuse of the Groq key") and authenticated (`/citizen/chatbot`, personalized with the citizen's own credit balance/ward).
- If `GROQ_API_KEY` is set: calls Groq's OpenAI-compatible chat completion endpoint (`openai/gpt-oss-20b` by default) with a system prompt fixing its persona, scope (civic sanitation only), and reply language (en/hi/gu), `temperature 0.4`, capped at 400 tokens, `reasoning_effort: 'low'`.
- Always has a **deterministic keyword-matched fallback** in all three languages (report-filing help, wet/dry bin sorting, credits/rewards explanation, helpline numbers, generic redirect) so the widget never errors out even with no API key or a failed call. The citizen-authenticated version in `citizen.routes.js` inlines its own copy of this same rule table rather than calling the shared service (duplicated logic — see §12).

---

## 8. Database schema (Prisma / PostgreSQL — 21 models)

Geometry is stored as plain `Float` lat/lng plus a precomputed bounding box (no PostGIS installed); the schema is deliberately shaped so enabling PostGIS later needs no application-code changes.

### Enums
`Role` (CITIZEN/DRIVER/OFFICER/ADMIN) · `ComplaintStatus` (PENDING/VERIFIED/ASSIGNED/IN_PROGRESS/RESOLVED/REJECTED) · `Severity` (LOW/MEDIUM/HIGH/CRITICAL) · `WasteCategory` (9 values, listed §7.2) · `VehicleStatus` (IDLE/ON_ROUTE/OFFLINE/MAINTENANCE) · `RouteStatus` (DRAFT/PUBLISHED/IN_PROGRESS/COMPLETED) · `StopStatus` (PENDING/DONE/SKIPPED) · `NotificationType` (COMPLAINT_UPDATE/ASSIGNMENT/EMERGENCY/ESCALATION/TRUCK_NEARBY/CREDIT_AWARDED/SYSTEM) · `SosStatus` (OPEN/ACKNOWLEDGED/RESOLVED) · `ReportChannel` (APP/WEB/WHATSAPP/IVR) · `ScheduledPickupStatus` (PENDING_REVIEW/APPROVED_SCHEDULED/ASSIGNED/IN_PROGRESS/COMPLETED/REJECTED/CANCELLED) · `WasteQuantity` (SMALL/MEDIUM/LARGE) · `TimeSlot` (MORNING/AFTERNOON/EVENING) · `LocationType` (MY_HOME/COMMON_PLOT_SOCIETY)

### Models

**User** — id, name, email? (unique), phone? (unique), passwordHash? (null = Google-only), role, wardId?, isActive, emailVerifiedAt?, language (en/hi/gu), avatarColor, avatarUrl?, twoFactorSecret?, twoFactorEnabled, greenCredits, lastLoginAt?, timestamps. Relations to nearly every other model (complaints filed/assigned/resolved, driven vehicle, routes, escalations received, audit logs, notifications, credit entries, SOS raised/acknowledged, fuel logs, scheduled pickups as citizen/driver, officer→ward links).

**OAuthIdentity** — Google sign-in linkage; unique on `(provider, providerUserId)`.

**RefreshToken** — hashed token, expiry, revokedAt?, replacedById? (rotation chain), userAgent, ip.

**EmailToken** — hashed token, purpose ("verify"/"reset"), expiry, usedAt?.

**OtpCode** — phone, hashed code, purpose (default "driver_login", also "driver_first_login"), expiry, consumedAt?, attempts.

**Ward** — name, code (unique), zone, boundary (GeoJSON Polygon Json), centerLat/Lng, minLat/maxLat/minLng/maxLng (precomputed bbox, indexed), population, households, slaMinutes (default 1440). Relations: residents, officers (via WardOfficer), complaints, vehicles, routes, hotspot predictions, emergency contacts, scheduled pickups.

**WardOfficer** — join table, officer↔ward, `isPrimary` flag, unique on `(wardId, officerId)` — an officer can cover multiple wards.

**Complaint** — the central entity. id, code (human ticket e.g. `SS-7F3K2Q`, unique), citizenId, wardId?, category, aiCategory?, aiConfidence, aiVerified, reviewNeeded, fraudScore, fraudSignals (Json), status, severity, isEmergency, channel, description?, latitude/longitude, address?, photoUrl?, thumbUrl?, assignedVehicleId?/assignedById?/assignedAt?, resolvedById?/resolvedAt?/resolutionPhotoUrl?/resolutionNote?, slaMinutes, dueAt?, escalationCount, upvotes, duplicateOfId?, timestamps. Indexed on status, (wardId,status), (isEmergency,status), createdAt, (lat,lng).

**ComplaintDuplicate** — parent↔duplicate link, similarityScore, method (default "geo+category+time"), distanceMeters?.

**ComplaintEvent** — the status timeline: complaintId, status, note?, actorId?, createdAt.

**Vehicle** — registrationNumber (unique), wardId?, driverId? (unique — one driver per vehicle), status, model (default "Tata Ace"), capacityKg, maintenanceFlag, denormalized lastLat/lastLng/lastHeading/lastSpeed/lastPingAt, odometerKm. Relations: locations (history), routes, complaints, SOS alerts, fuel logs, scheduled pickups.

**VehicleLocation** — every ping kept for replay: vehicleId, lat/lng, heading?, speed?, accuracy?, recordedAt. Indexed (vehicleId, recordedAt).

**Route** — one row per vehicle per calendar day (`@@unique([vehicleId, date])`), date as `YYYY-MM-DD` string, status, label?, orderedStops (Json array mirroring the solver's stop shape), polylineGeometry (Json `[[lng,lat],...]`), baselineKm/distanceKm/durationMin/actualKm/savedKm/fuelSaved/co2SavedKg, solver name (default "safaai-node-2opt"), solveMs, startedAt?/completedAt?.

**Escalation** — complaintId, escalatedToId?, level, reason, escalatedAt, acknowledgedAt?.

**AuditLog** — immutable: actorId?, action, targetTable, targetId?, before?/after? (Json), ip?, userAgent?. Indexed (actorId,createdAt) and (targetTable,targetId).

**Notification** — userId, type, title, body, payload? (Json), readAt?.

**GreenCredit** — userId, delta, balanceAfter (snapshot), reason, reasonCode, complaintId?.

**SosAlert** — driverId, vehicleId?, lat/lng, message?, status, acknowledgedById?/acknowledgedAt?.

**FuelLog** — driverId, vehicleId, liters?, odometerKm?, cost?, notes?, receiptUrl?, loggedAt.

**HotspotPrediction** — one row per ward+forDate (`@@unique`), predictedCount, riskScore, confidence, drivers (Json feature list shown in UI), modelVersion.

**EmergencyContact** — name, category (helpline/fire/animal_control/pest_control/police/hospital), phone, wardId? (null = city-wide), isCityWide, address?.

**ModelHealthSample** — modelVersion, avgConfidence, lowConfidenceRate, falsePositiveRate, sampleCount, recordedAt.

**ScheduledPickupRequest** — code (unique, `SP-XXXXXX`), citizenId, wardId?, locationType, address, lat/lng, eventReason, expectedCategories (Json array), expectedQuantity, scheduledDate, scheduledTimeSlot, additionalNotes?, status, rejectionReason?, assignedDriverId?/assignedVehicleId?/assignedById?/assignedAt?, completedAt?/completionPhotoUrl?/completionNotes?, reminderSent flag.

---

## 9. Full API endpoint reference

All routes prefixed `/api`. Auth via `Authorization: Bearer <accessToken>`, portal-checked by `requirePortal()` on every router except `auth` and `public`.

### `/api/auth` (public)
`POST citizen|driver|officer|admin/login` · `POST 2fa/verify` · `POST citizen/register` · `POST verify-email` · `POST forgot-password` · `POST reset-password` · `POST driver/otp/request` · `POST driver/otp/verify` · `POST driver/first-login-verify` · `GET citizen/google` · `GET citizen/google/callback` · `POST citizen/google/token` · `POST refresh` · `POST logout` · `GET citizen|driver|officer|admin/me` · `POST 2fa/setup` (admin) · `POST 2fa/confirm` (admin) · `GET demo-accounts`

### `/api/public` (no auth)
`POST chatbot` · `GET stats` · `GET wards` · `GET categories`

### `/api/citizen` (CITIZEN token required)
`GET home` · `GET feed` · `POST report` · `POST emergency` · `GET duplicates/check` · `POST complaints/:id/upvote` · `GET complaints` · `GET complaints/:id` · `GET complaints/:id/track` · `GET credits` · `POST rewards/redeem` · `GET leaderboard` · `POST chatbot` · `GET directory` · `GET categories` · `PATCH profile` · `POST profile/avatar` · `GET notifications` · `POST notifications/read` · `POST scheduled-pickup` · `GET scheduled-pickup` · `GET scheduled-pickup/:id` · `POST scheduled-pickup/:id/cancel`

### `/api/driver` (DRIVER token required)
`GET route` / `GET shift` · `GET tasks` · `POST tasks/:id/start` / `POST complaints/:id/start` · `POST tasks/:id/complete` / `POST complaints/:id/resolve` · `POST fuel-log` · `GET fuel-log` · `POST sos` · `GET shift-summary` / `GET summary` · `POST location` · `POST location/batch` · `POST stops/:seq/skip` · `POST status` · `GET next-stop` · `GET scheduled-tasks` · `POST scheduled-tasks/:id/complete`

### `/api/officer` (OFFICER token, or ADMIN)
`GET wards` · `GET dashboard` / `GET overview` · `GET queue` / `GET complaints` · `GET complaints/:id` · `ALL complaints/:id/reject` · `POST complaints/:id/verify` · `POST assign` / `POST complaints/assign` · `GET fleet` · `GET hotspots` / `GET heatmap` · `GET recommendations` · `POST simulate` · `GET emergencies` · `POST emergencies/:id/ack` / `POST sos/:id/acknowledge` · `GET analytics` · `GET escalations` · `POST complaints/:id/escalate` · `POST routes/optimize` · `POST routes/publish` · `POST drivers` · `GET scheduled-requests` · `POST scheduled-requests/:id/approve` · `POST scheduled-requests/:id/reject` · `POST scheduled-requests/:id/assign`

### `/api/admin` (ADMIN token required)
`GET dashboard` / `GET overview` · `GET fleet` · `POST fleet` · `PATCH fleet/:id` · `GET fleet/:id/route` · `GET users` · `POST users` · `PATCH users/:id/block` / `PATCH users/:id/toggle-block` · `PATCH users/:id` · `GET wards` · `POST wards` · `PATCH wards/:id` · `GET exports` / `GET export/compliance` · `GET audit-logs` / `GET audit` · `GET model-health` · `GET analytics` · `GET hotspots` · `GET categories` · `POST reseed-demo-data`

---

## 10. Realtime — Socket.io

**Rooms**: `ward:<id>` (officers/admins watching a ward), `truck:<id>` (one vehicle — citizens tracking a complaint join only this), `user:<id>` (personal notifications), `complaint:<id>`, `city` (admin city-wide + all admins auto-join on connect). Room join is validated against a strict regex; joining a `ward:*` room requires an authenticated session.

**Events**: `truck:update`, `driver:location` (client→server), `complaint:new`, `complaint:update`, `emergency:new`, `escalation:new`, `assignment:new`, `sos:new`, `notification:new`, `stats:update`.

Auth on connect is via `socket.handshake.auth.token` (the same JWT access token); an unauthenticated socket can still connect (for public landing-page stats) but can't join ward rooms. On driver token role, the server accepts `driver:location` events over the socket as an alternative to the REST endpoint, feeding the exact same `ingestLocation` path. A Redis adapter attaches automatically if `REDIS_URL` is set, syncing rooms across multiple server instances.

---

## 11. AI / Vision microservices — what's real vs. stand-in (read this before redesigning any "AI" UI)

This matters for design honesty (the app itself has a `DegradedNotice` UI pattern for exactly this reason):

| Model | Real or stand-in? | Detail |
|---|---|---|
| **Vision classifier** (`backend/vision`, FastAPI+YOLOv8) | **Real**, if `models/safaai_best.pt` weights are present — a custom-trained Ultralytics YOLO model, returns `predicted_category`, confidence %, `needs_manual_review` (<70%). This is what `NewReport.tsx` actually calls. |
| **Vision classifier** (`backend/api`'s fallback, `ai.service.js` → `localClassify`) | **Stand-in** — SHA-256 digest of image bytes deterministically picks a category; confidence is real-ish in that it's damped by genuinely measured entropy/resolution, but the category choice itself is not a model inference. |
| **Vision classifier** (`backend/ai` Node service, `models.js` → `classify`) | **Documented stand-in** — same digest-based approach, `engine: 'stub'` unless `ONNX_MODEL_PATH` is set and implemented (it currently throws "not implemented" if set). |
| **Duplicate-similarity embedder** | **Stand-in** — a perceptual-hash-style function (SHA-256 + Hamming distance + aspect ratio), not real CLIP embeddings. Honest: identical bytes score 1.0 (catches literal re-uploads); different images score weakly. The *load-bearing* duplicate signal in production is the geo+category+time heuristic in §7.3, not this. |
| **Hotspot predictor** | **Real computation**, but a seasonal-naive statistical baseline (recency-weighted same-weekday average + trend), not the LightGBM model the README markets. Explicitly labeled `engine: 'seasonal-baseline'` in every response. |
| **Fraud/anomaly scorer** | **Real computation** — a genuine logistic function, hand-set (not trained) coefficients over real measured features. |
| **Route solver** | **Real** — nearest-neighbour + 2-opt + Or-opt actually runs and actually improves on the baseline; this is not a stand-in. |
| **What-if simulator** | **Real** — genuine Poisson-Markov Monte Carlo, not a fixed formula. |
| **Chatbot** | **Real** LLM call when `GROQ_API_KEY` is set; otherwise a real (if simple) deterministic rule engine — never fails silently. |

The codebase's own comments are unusually candid about this ("this repository ships no trained weights... `engine` in every response says which is which: `stub` vs `onnxruntime`"), which is worth preserving as a design/UX principle if this gets rebuilt: **never claim a model result that isn't real** — surface degraded/fallback state visibly (the existing `DegradedNotice` component) rather than hiding it.

---

## 12. Known inconsistencies worth knowing before redesigning

- **`NewReport.tsx` calls endpoints that don't exist in the read backend routes**: it posts to `/citizen/classify-waste` (expecting the vision service's response shape `{status, predicted_category, confidence, needs_manual_review, remark}` directly) and to `POST /citizen/complaints` (not `/citizen/report`), and does a duplicate pre-check via `GET /citizen/complaints/nearby` — none of these three paths exist in `citizen.routes.js` as read (`§9`). Either there's a proxy/rewrite not seen in this pass, an older/newer version drift between frontend and backend, or this flow is presently broken end-to-end. Verify against the running server before treating this screen's data flow as authoritative.
- **Duplicated chatbot rule logic**: `citizen.routes.js`'s inline `/citizen/chatbot` handler and `services/chatbot.service.js`'s `ruleBasedReply` implement the same four-intent keyword matching independently (copy-pasted, not shared) — the citizen-authenticated version never calls the Groq-backed shared service at all, so an authenticated citizen never gets the smarter LLM reply that a logged-out visitor on the landing-page widget can get from `/public/chatbot`.
- **Two "AI services" listen on the same default port (8100)** — `backend/ai` (Node stand-ins) and `backend/vision` (Python/YOLO) both default to 8100 and are not both runnable simultaneously without overriding one. The main API's `ai.service.js` targets the **vision** service's route shape (`/api/classify-waste`), so in practice `backend/vision` is the one meant to be running for `createComplaint`'s photo classification — `backend/ai` appears to be either an earlier or alternate implementation.
- **README markets a LightGBM hotspot model and CLIP embeddings**; the actual running code is a seasonal-naive statistical baseline and a perceptual-hash stand-in respectively (both honestly labeled in API responses, per §11). Don't design UI copy that overstates model sophistication beyond what `modelVersion`/`engine` fields actually report.
- **Escalations screen is routed but not in the officer nav bar** — reachable only by typing `/officer/escalations`. Decide deliberately whether a redesign should surface it.

---

## 12b. Additional shared-component detail (verified, for Claude Design reuse)

- **`SpotlightNav.tsx`** — the nav bar used in every shell header and on the Login portal-switcher: mouse-follow radial "spotlight" glow, a sliding active-tab pill measured via `getBoundingClientRect` and animated with CSS transform, plus a bottom ambient light beam under the active tab.
- **`map/Map.tsx`** (Leaflet wrapper library, reused across all 4 portals) — `BaseMap` (OSM street or Esri satellite; dark mode achieved by CSS `filter: invert(1) hue-rotate(180deg) brightness(.92) contrast(.92) saturate(.7)` on the tile layer, not a second tile provider), `TruckMarker` (requestAnimationFrame glide interpolation ~1.8s ease-out between GPS fixes, hard snap on >2km jump or reduced-motion, heading-rotated SVG + pulsing ring), `RouteLine` (grey-done / green-remaining split polyline), `WardLayer`, `ComplaintLayer` (weighted translucent density circles), `PinMarker`, `StopDot`, `LocationPicker`.
- **`ScratchCard.tsx`** — canvas scratch-to-reveal (pointer-driven `destination-out` compositing), fires reveal once >50% of a sampled pixel grid is cleared; used for the Rewards voucher catalog.
- **`ConfettiBurst.tsx`** — pure-CSS 110-piece dual-cannon confetti, 2.4s auto-dismiss, fires on reward claim.
- **`Chatbot.tsx`** — floating FAB widget, localized quick-prompts, deterministic localized fallback if the API call fails.
- **`ErrorBoundary.tsx`** — class component, reload/home recovery card on render crash.
- Fluid type scale (`text-fluid-xs…3xl`, all `clamp()`) spans 360px phone to 1440px desktop with no breakpoint-based font switching.
- Safe-area insets (`env(safe-area-inset-*)`) used throughout for installed-PWA notch/home-bar clearance; a `44px` minimum touch-target token is enforced on all tappable elements.
- **API/state layer specifics**: one Axios instance *and* one Socket.IO connection per portal, each with its own `localStorage` keys (`ss_token_{portal}`, `ss_user_{portal}`) — four independent sessions can coexist in one browser tab with zero cross-contamination. TanStack Query is the only server-state layer (`staleTime: 20s`, `retry: 1`); no Redux/Zustand — only React Context for Auth and i18n.

---

## 13. Environment / configuration reference

Key env vars (`backend/api/.env`): `PORT` (5100), `DATABASE_URL`, `JWT_ACCESS_SECRET`/`JWT_ACCESS_TTL` (15m)/`JWT_REFRESH_SECRET`/`JWT_REFRESH_TTL_DAYS` (7), `COOKIE_DOMAIN`/`COOKIE_SECURE`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`, `CLIENT_ORIGIN` (comma-separated allowed CORS origins), `AI_SERVICE_URL` (default `http://127.0.0.1:8100`), `GROQ_API_KEY`/`GROQ_MODEL`, `ROUTING_SERVICE_URL` (optional external OSRM/OR-Tools), `REDIS_URL` (optional, enables Redis rate-limit store + Socket.io adapter), `STORAGE_DRIVER` (local/supabase) + `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_BUCKET`, `AI_CONFIDENCE_AUTO_APPROVE` (0.7), `AI_FRAUD_REVIEW_THRESHOLD` (0.6), `ESCALATION_EMERGENCY_MINUTES` (30)/`ESCALATION_STANDARD_MINUTES` (1440), `SIMULATOR_ENABLED` (true)/`SIMULATOR_INTERVAL_MS` (2000).

Frontend (`frontend/.env`): `VITE_API_URL` (defaults to same-origin, so the SPA and API are typically deployed together or proxied).

Ports in dev: Frontend 5273, API 5100, AI/Vision service 8100.

Rate limits: login 10/15min per IP+identifier, OTP 5/10min, general writes 30/min, complaint reports 20/hour, chatbot 20/10min.
