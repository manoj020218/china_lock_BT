"""Build docs/jenix-gateway-handover.html — one-page delivery note for a client.

Re-uses the stylesheet and footer of docs/jenix-gateway-api.html. Edit the text
below and re-run:  python docs/build_handover.py
"""

from pathlib import Path

DOCS = Path(__file__).resolve().parent
api = (DOCS / "jenix-gateway-api.html").read_text(encoding="utf-8")
style = api[api.index("<style>") : api.index("</style>") + len("</style>")]
footer = api[api.index("<footer>") : api.index("</footer>") + len("</footer>")]
footer = footer.replace("Jenix Lock Gateway — API &amp; Integration Guide", "Jenix Lock Gateway — Handover Note")

FW = "1.2.14"
DATE = "26 November 2026"

EXTRA_CSS = """<style>
  main{max-width:900px}
  .check{list-style:none;padding:0}
  .check li{padding:6px 0 6px 28px;position:relative;font-size:14.5px}
  .check li::before{content:"\\2610";position:absolute;left:0;top:4px;font-size:17px;color:var(--accent)}
  ol.steps{counter-reset:s;list-style:none;padding:0;margin:10px 0}
  ol.steps>li{counter-increment:s;position:relative;padding:7px 0 7px 40px;font-size:14.5px}
  ol.steps>li::before{content:counter(s);position:absolute;left:0;top:5px;width:26px;height:26px;border-radius:50%;
    background:linear-gradient(135deg,#6ea8ff,#9b7bff);color:#0a0f22;font-weight:800;display:grid;place-items:center;font-size:12.5px}
</style>"""

BODY = f"""
<header class="hero">
  <span class="tag">Handover note &middot; gateway firmware {FW} &middot; {DATE}</span>
  <h1>Jenix Lock Gateway — Handover</h1>
  <p class="lead">Everything you need to take over the Jenix Lock Gateway and build your own software on its HTTP API.
  The full endpoint reference is in the <b>API &amp; Integration Guide</b>; this note covers what you receive, the
  first-time setup and the rules that matter most.</p>
</header>

<div class="pillrow">
  <span class="pill">Firmware {FW}</span>
  <span class="pill">HTTP/JSON over Wi-Fi (LAN)</span>
  <span class="pill">Bearer token</span>
  <span class="pill">Several locks per gateway</span>
</div>

<h2 id="box">1 · What you receive</h2>
<ul class="check">
  <li>Jenix Lock Gateway (ESP32-S3), firmware <b>{FW}</b>, <b>factory-fresh</b> (LED blinking purple on power-up)</li>
  <li>5 V / 2 A USB power adapter — use this or an equivalent; weak chargers cause restarts</li>
  <li><code>jenix-gateway-api.html</code> — API &amp; Integration Guide (all endpoints, examples, errors)</li>
  <li><code>jenix-lock-user-guide.html</code> — end-user guide for the Jenix Lock app</li>
  <li>Optional: Jenix Lock app (Android test build) for quick setup and testing</li>
</ul>

<h2 id="setup">2 · First-time setup (choose one)</h2>
<h3>A · With the Jenix Lock app</h3>
<p>Tap <b>+</b> &rarr; <b>Set up new gateway</b> and follow the steps. The app connects the gateway to your Wi-Fi and
stores its API token. Read the token later from the gateway's USB console (<code>TOKEN</code>) if your software needs it.</p>
<h3>B · From your own software (no app)</h3>
<ol class="steps">
  <li>Power the gateway; join its open Wi-Fi <b>JenixLock-XXXX</b>. The gateway is at <code>192.168.4.1</code>.</li>
  <li><code>GET http://192.168.4.1/api/health</code> &rarr; <code>"setup": true</code> and the <code>device_id</code>.</li>
  <li><code>POST http://192.168.4.1/api/provision</code> with <code>{{"ssid":"&lt;wifi&gt;","pass":"&lt;password&gt;"}}</code>.
  The reply contains <b>your API token</b> — store it securely.</li>
  <li>Poll <code>GET /api/provision/status</code> until <code>"state":"connected"</code>; note the new <code>ip</code>.</li>
  <li><code>POST /api/provision/finish</code> (with the token) closes the setup network. Rejoin your Wi-Fi and use
  <code>http://&lt;ip&gt;</code> from now on.</li>
</ol>
<div class="note">If the gateway's IP changes later, find it again by probing <code>GET /api/health</code> on the subnet and
matching <code>device_id</code>, or via mDNS <code>jenixlock-xxxx.local</code>.</div>

<h2 id="locks">3 · Add a lock</h2>
<ol class="steps">
  <li>Wake the lock (touch its keypad). <code>GET /api/scan</code> lists nearby locks as <code>Lck1_&lt;ID&gt;</code>.
  Use the <b>bare ID</b> after the underscore everywhere.</li>
  <li>Optional: <code>GET /api/probe?lock=&lt;ID&gt;</code> checks the model; <code>"supported": true</code> is required.</li>
  <li><code>POST /api/bind</code>:
    <ul>
      <li><b>New or factory-reset lock:</b> <code>{{"lock_id":"&lt;ID&gt;","password":"&lt;6 digits&gt;","tz_minutes":330,"set_password":true}}</code>
      — the gateway sets this connection password on the lock.</li>
      <li><b>Lock already set up:</b> the same without <code>set_password</code>, using its existing 6-digit connection password.</li>
    </ul></li>
  <li>Verify: <code>GET /api/version?lock=&lt;ID&gt;</code>. Error <code>login error 19/33</code> = wrong password
  (unbind and retry); <code>-1</code> = lock asleep (wake it, retry).</li>
</ol>

<h2 id="rules">4 · Rules that matter</h2>
<table>
  <tr><th>Topic</th><th>Rule</th></tr>
  <tr><td>Lock ID</td><td>Always the bare ID (<code>8F3EE684ECE3</code>), never <code>Lck1_…</code> — it is part of the login key.</td></tr>
  <tr><td>Connection password</td><td>6 digits, used only by the gateway to log in. <b>Not</b> a keypad PIN.</td></tr>
  <tr><td>Unlock / lock</td><td>Send a lock user's ID + that user's keypad PIN. <code>502 "unlock rejected"</code> = wrong user/PIN.</td></tr>
  <tr><td>PINs</td><td>Must be unique per lock. A refused PIN returns <code>409</code> — show users only "choose a
  different PIN", never the reason (it would reveal another user's PIN).</td></tr>
  <tr><td>Temporary door codes</td><td>Generated offline from the <b>keypad admin PIN</b> and the lock's local time
  (its time zone). Algorithm and test vector are in the API guide.</td></tr>
  <tr><td>Auto close</td><td>The lock's own delay needs its door magnet; for API/app unlocks use
  <code>/api/settings/app-autoclose</code> (gateway re-locks, no magnet needed).</td></tr>
  <tr><td>Battery</td><td>The gateway measures every lock every 6 h — read <code>GET /api/alerts</code> (<code>low</code> below 25 %).</td></tr>
  <tr><td>Records</td><td>Merge the lock's log (PIN, fingerprint, card) with the gateway's log (app, cloud, auto close).</td></tr>
</table>

<h2 id="net">5 · Network &amp; security</h2>
<ul>
  <li>Plain HTTP on the local network; every endpoint except <code>/api/health</code> needs the bearer token. Keep the
  token server-side; reset the gateway to rotate it.</li>
  <li><b>Wi-Fi repeaters with the same network name</b> may block traffic between their clients and the main router's
  clients. The gateway joins the strongest access point; <code>/api/health</code> shows which one
  (<code>wifi_bssid</code>). Prefer one router or a proper mesh system for the gateway's Wi-Fi.</li>
  <li>Place the gateway within about 5–8 m of the locks. <code>GET /api/signal?lock=…</code> shows the live signal.</li>
</ul>

<h2 id="ops">6 · Updates, reset &amp; light</h2>
<ul>
  <li><b>Firmware updates:</b> from the Jenix Lock app (Gateway settings &rarr; Update) or
  <code>POST /api/ota/upload</code>. Wi-Fi, token and locks are kept; a bad file is rejected.
  <code>/api/health</code> reports <code>fw_version</code>.</li>
  <li><b>Factory reset (gateway only):</b> press RESET 10&times;, about once per second (white blink per press, amber
  from the 5th, then purple). Clears Wi-Fi, token and bindings — never the locks' users.</li>
  <li><b>Light:</b> purple blink = setup · blue = online · red blink = Wi-Fi lost · 3 red flashes = a command failed ·
  2 green flashes = unlocked · amber flash = locked.</li>
</ul>

<h2 id="tested">7 · Tested &amp; not yet included</h2>
<div class="grid2">
  <div class="card">
    <h3 style="margin-top:0">Validated on hardware</h3>
    <p class="muted" style="font-size:14px">Locks BK50D-V2.5 and BK21F-V2.6.1 · Wi-Fi setup without IP typing ·
    new-lock password setup · unlock/lock · users, PIN change, fingerprint and card enrollment · door codes ·
    auto close after app unlock · battery read · records with names · firmware update from the app.</p>
  </div>
  <div class="card">
    <h3 style="margin-top:0">Next phase</h3>
    <p class="muted" style="font-size:14px">Cloud connection (remote access and push alerts through your server — the
    gateway's MQTT client exists, the server side does not) · signed Play Store release of the app · locks with
    newer login protocols (<code>command_version</code> &gt; 0).</p>
  </div>
</div>
"""

page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jenix Lock Gateway — Handover Note</title>
{style}
{EXTRA_CSS}
</head>
<body>
<div class="layout">
  <aside>
    <div class="brand">
      <div class="logo">&#128274;</div>
      <div>
        <div class="n">Jenix Lock Gateway</div>
        <div class="s">Handover Note</div>
      </div>
    </div>
    <nav>
      <div class="grp">Handover</div>
      <a href="#box">1 · What you receive</a>
      <a href="#setup">2 · First-time setup</a>
      <a href="#locks">3 · Add a lock</a>
      <a href="#rules">4 · Rules that matter</a>
      <a href="#net">5 · Network &amp; security</a>
      <a href="#ops">6 · Updates, reset &amp; light</a>
      <a href="#tested">7 · Tested &amp; next phase</a>
    </nav>
  </aside>
  <main>
{BODY}
  </main>
</div>
{footer}
</body>
</html>
"""

(DOCS / "jenix-gateway-handover.html").write_text(page, encoding="utf-8")
print("wrote docs/jenix-gateway-handover.html")
