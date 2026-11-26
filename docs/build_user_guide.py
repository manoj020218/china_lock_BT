"""Build docs/jenix-lock-user-guide.html (end-user guide for the Jenix Lock app).

Re-uses the stylesheet and footer of docs/jenix-gateway-api.html so both client
documents look like one set. Edit the SECTIONS below and re-run:

    python docs/build_user_guide.py
"""

from pathlib import Path

DOCS = Path(__file__).resolve().parent
api = (DOCS / "jenix-gateway-api.html").read_text(encoding="utf-8")
style = api[api.index("<style>") : api.index("</style>") + len("</style>")]
footer = api[api.index("<footer>") : api.index("</footer>") + len("</footer>")]
footer = footer.replace("Jenix Lock Gateway — API &amp; Integration Guide", "Jenix Lock — User Guide").replace(
    "For integration support, contact us:", "For help, contact us:"
)

EXTRA_CSS = """<style>
  ol.steps{counter-reset:s;list-style:none;padding:0;margin:10px 0}
  ol.steps>li{counter-increment:s;position:relative;padding:8px 0 8px 42px;font-size:14.5px}
  ol.steps>li::before{content:counter(s);position:absolute;left:0;top:6px;width:28px;height:28px;border-radius:50%;
    background:linear-gradient(135deg,#6ea8ff,#9b7bff);color:#0a0f22;font-weight:800;display:grid;place-items:center;font-size:13px}
  .dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:6px;vertical-align:-1px}
  .kbd{display:inline-block;border:1px solid var(--stroke);border-bottom-width:2px;border-radius:6px;padding:0 7px;
    font-family:ui-monospace,monospace;font-size:13px;background:rgba(255,255,255,.04)}
</style>"""

NAV = [
    ("Start here", [("intro", "What you need"), ("setup-gw", "1 · Set up the gateway"), ("add-lock", "2 · Add a lock")]),
    ("Every day", [("open", "Open & close"), ("users", "Users & fingerprints"), ("code", "Temporary door code"),
                   ("records", "Records & attendance")]),
    ("Settings", [("autoclose", "Auto close"), ("normopen", "Normally open"), ("alerts", "Battery alerts"),
                  ("gateway", "Gateway settings & updates")]),
    ("Help", [("led", "Gateway light"), ("trouble", "Troubleshooting"), ("safety", "Safety")]),
]

SECTIONS = """
<header class="hero" id="top">
  <span class="tag">User Guide &middot; app 0.1 &middot; gateway 1.2.5</span>
  <h1>Jenix Lock — User Guide</h1>
  <p class="lead">Control your Jenix smart locks from your phone through the Jenix Lock gateway: open and close,
  manage users and fingerprints, share one-time door codes, get low-battery alerts and download attendance
  reports.</p>
</header>

<div class="flow">
  <div class="node"><div class="t">Jenix Lock app</div><div class="d">on your phone</div></div>
  <div class="arr">&#8594;<small>home Wi-Fi</small></div>
  <div class="node"><div class="t">Jenix gateway</div><div class="d">small box, plugged in near the door</div></div>
  <div class="arr">&#8594;<small>Bluetooth</small></div>
  <div class="node"><div class="t">Your lock(s)</div><div class="d">one gateway, several locks</div></div>
</div>

<h2 id="intro">What you need</h2>
<ul>
  <li>The Jenix gateway and a good <b>5 V / 2 A USB adapter</b> (weak phone chargers can make it restart).</li>
  <li>Your home or office <b>2.4 GHz Wi-Fi</b> name and password (5 GHz-only networks are not supported).</li>
  <li>An Android phone with the <b>Jenix Lock</b> app.</li>
  <li>For each lock: its <b>connection password</b> if it was set up before — or a factory-reset lock.</li>
</ul>
<div class="note warn"><b>Wi-Fi extenders:</b> if your Wi-Fi uses an extender/repeater with the same network name,
the phone and the gateway may land on different ones and not see each other. Prefer one router (or a proper
mesh system) for the gateway's Wi-Fi.</div>
<div class="note">Place the gateway within about <b>5–8 m</b> of the locks with few walls in between, and away from
metal door frames. The app shows the signal strength so you can find a good spot.</div>

<h2 id="setup-gw">1 · Set up the gateway</h2>
<ol class="steps">
  <li>Plug in the gateway. A new gateway blinks <b>purple</b> and creates a Wi-Fi network called
  <b>JenixLock-XXXX</b>.</li>
  <li>In the app tap <b>+</b> &rarr; <b>Set up new gateway</b>.</li>
  <li>Open your phone's Wi-Fi settings and join <b>JenixLock-XXXX</b>. If Android says <i>"No internet"</i>,
  choose <b>Stay connected</b>. Return to the app and tap <b>I've joined</b>.</li>
  <li>Tap your Wi-Fi name in the list, enter its password (tap the eye icon to check it), give the gateway a
  name and tap <b>Connect gateway</b>.</li>
  <li>The gateway joins your Wi-Fi and the phone returns to it automatically. The gateway light turns
  <b>blue</b> and the app shows it as <b>online</b>.</li>
</ol>
<div class="note">You never type an IP address. If the router later gives the gateway a new address, the app finds
it again by itself.</div>

<h2 id="add-lock">2 · Add a lock</h2>
<ol class="steps">
  <li>Touch the lock's keypad to wake it, then on the gateway card tap <b>Scan &amp; add a lock</b>.</li>
  <li>Pick your lock in the list (it shows as <code>Lck1_…</code>) and give it a name, e.g. <i>Main door</i>.</li>
  <li>Choose:
    <ul>
      <li><b>New / reset lock</b> — the app sets a new 6-digit <b>connection password</b> (type it twice and keep
      it safe; you need it to add this lock again).</li>
      <li><b>Already set up</b> — enter the lock's existing 6-digit connection password.</li>
    </ul></li>
  <li>Pick the time zone (India is the default) and tap <b>Connect lock</b>. The app checks the password with the
  lock before saving.</li>
  <li>Choose <b>who opens the door</b> from the app: tap a user from the list and enter that user's keypad PIN.</li>
</ol>
<div class="note warn"><b>Connection password &ne; keypad PIN.</b> The connection password is only for the app and
gateway. A keypad admin PIN will not work here. If you don't know a lock's connection password, factory-reset the
lock and add it as a <b>new</b> lock (this erases its users and fingerprints).</div>

<h2 id="open">Open &amp; close</h2>
<ul>
  <li>Open the lock from the list and tap <b>Unlock</b> or <b>Lock</b>. With auto close on, the button counts down
  <i>"Closes in 10s"</i>.</li>
  <li>The <b>Connection</b> card shows the live signal between lock and gateway (Bluetooth) and gateway and router
  (Wi-Fi): <b>Excellent / Good / Fair / Weak</b>. It measures for one minute to save the lock battery — tap
  <b>Measure again</b> to refresh.</li>
  <li>The 🔋 badge on the lock list shows its battery; it turns red below 25 %.</li>
  <li>Tap the lock name at the top to rename it.</li>
</ul>

<h2 id="users">Users, fingerprints, cards &amp; PINs</h2>
<p>In the <b>Users</b> tab each person shows three icons — <b>fingerprint, card and PIN</b> — that turn
<b style="color:#35d393">green</b> when enrolled. Tap a user to:</p>
<ul>
  <li><b>Rename</b> them (e.g. staff names for the attendance report).</li>
  <li><b>Add a fingerprint</b>: tap <i>Add finger</i>, then place the same finger on the lock's sensor, lift and
  repeat about 3 times when the lock beeps.</li>
  <li><b>Add a card</b>: tap <i>Add card</i> and hold the card flat on the keypad.</li>
  <li><b>Set or change the PIN</b> (numbers only, 4–16 digits). If the lock says the PIN can't be used, simply
  choose a different one.</li>
  <li><b>Access validity</b>: <i>Permanent</i>, or <i>Custom</i> dates, daily hours and days — for example staff
  Monday–Saturday 09:00–18:00. Expired users are shown in red.</li>
  <li><b>Delete</b> the user and all their fingerprints, cards and PIN.</li>
</ul>

<h2 id="code">Temporary door code (one-time PIN)</h2>
<p>Give a visitor or delivery person a 6-digit code without adding them as a user. The code is valid only for the
current <b>5-minute</b> window and works even if the internet is down.</p>
<ol class="steps">
  <li>On the <b>Control</b> tab, enter the lock's <b>keypad admin PIN</b> once (the PIN the admin user types on
  the keypad — <i>not</i> the connection password) and tap <b>Generate code</b>.</li>
  <li>Tap <b>WhatsApp</b> or <b>SMS</b> (or <b>More…</b>) to send it. The message includes the instructions.</li>
  <li>The visitor wakes the keypad, presses <span class="kbd">*</span>, enters the code, then presses
  <span class="kbd">#</span> — the lock opens.</li>
</ol>
<div class="note">Codes use the lock's time (its time zone is set when the lock is added), so they work even
if your phone is set to another time zone. Keep the phone's date &amp; time on <b>automatic</b>. A code only works
during the 5-minute window shown under it.</div>

<h2 id="records">Records &amp; attendance (Excel)</h2>
<ul>
  <li>The <b>Records</b> tab lists every opening: <i>Keypad PIN, Fingerprint, Card, Phone app</i> and <i>Auto
  close</i>, with the user and time. Refused attempts are marked.</li>
  <li>Choose <i>Today / 7 / 30 / 90 days</i> and tap <b>Download Excel (attendance)</b>. The file has three
  sheets:
    <ul>
      <li><b>Attendance</b> — per person per day: first IN, last OUT, hours, number of entries.</li>
      <li><b>Summary</b> — per person: days present and total hours (for salary/payroll).</li>
      <li><b>Full log</b> — every event.</li>
    </ul></li>
  <li>Share it by WhatsApp, e-mail or Drive straight from the share menu.</li>
</ul>

<h2 id="autoclose">Auto close</h2>
<p>Lock &rarr; <b>Settings</b> &rarr; <b>Auto close the lock</b>: pick <b>5s / 10s / 15s / 30s / 1 min</b> (or
3–60 s) and tap <b>Save</b>.</p>
<ul>
  <li><b>Also close after app unlock</b> (on by default): after you unlock from the app, the gateway locks the door
  again itself after that time — this works <b>without</b> a door magnet.</li>
  <li>Openings with keypad PIN, fingerprint or card are closed by the lock itself, which needs its <b>door
  magnet</b> fitted to see that the door is shut.</li>
</ul>
<div class="note warn">Auto close locks after the set time even if the door is still open. Choose a time long
enough to walk through.</div>

<h2 id="normopen">Normally open</h2>
<p>Keep the door <b>unlocked</b> during set hours — for example an office during working hours. Lock &rarr;
<b>Settings</b> &rarr; <b>Normally open</b>: turn it <b>On</b>, set From–To (or <b>Whole day</b>) and the days,
then <b>Save</b>.</p>
<div class="note danger"><b>Anyone can open the door during this time.</b> Auto close does not act inside the
window. To lock manually during it, press and hold <span class="kbd">0</span> on the keypad. If you save Auto close
while Normally open is on, the app offers to turn Normally open off.</div>

<h2 id="alerts">Low-battery alerts</h2>
<ul>
  <li>The gateway checks every lock's battery a few times a day.</li>
  <li>Below <b>25 %</b> the phone alerts you with <b>sound and vibration</b> — inside the app, and as a
  <b>notification</b> when the app is in the background or closed (while the phone is on the same Wi-Fi as the
  gateway).</li>
  <li>Allow notifications when the app asks. Use <b>Settings &rarr; Low-battery alerts &rarr; Test alert</b> to
  check sound and vibration, or <b>Check batteries now</b>.</li>
</ul>

<h2 id="gateway">Gateway settings &amp; firmware updates</h2>
<p>Tap the ⚙ on the gateway card:</p>
<ul>
  <li><b>Gateway firmware</b>: shows the installed version and the version included in your app. When the gateway
  card shows <span style="color:#ffb648">update available</span>, tap <b>Update gateway</b>. Keep the app open
  on the same Wi-Fi for about a minute. Your Wi-Fi, locks and settings are kept; if anything goes wrong the gateway
  keeps its current firmware.</li>
  <li><b>Radio power</b>: <i>Normal</i> or <i>High</i> for Wi-Fi and Bluetooth. Use High only with a good
  5 V / 2 A adapter; if the gateway restarts from a power dip it lowers the power by itself.</li>
  <li><b>Remove gateway</b> removes it from this phone only.</li>
</ul>

<h2 id="led">Gateway light</h2>
<table>
  <tr><th>Light</th><th>Meaning</th></tr>
  <tr><td><span class="dot" style="background:#9b59ff"></span>Purple, blinking</td><td>Waiting for Wi-Fi setup</td></tr>
  <tr><td><span class="dot" style="background:#4f7dff"></span>Blue, steady</td><td>Online on your Wi-Fi</td></tr>
  <tr><td><span class="dot" style="background:#35d393"></span>Green, steady</td><td>Online and connected to the cloud</td></tr>
  <tr><td><span class="dot" style="background:#ff6b6b"></span>Red, blinking</td><td>Wi-Fi lost — reconnecting by itself</td></tr>
  <tr><td><span class="dot" style="background:#35d393"></span>Two green flashes</td><td>Door unlocked</td></tr>
  <tr><td><span class="dot" style="background:#ffb648"></span>One amber flash</td><td>Door locked</td></tr>
  <tr><td><span class="dot" style="background:#ff6b6b"></span>Three red flashes</td><td>A command failed (e.g. lock out of range)</td></tr>
</table>

<h2 id="trouble">Troubleshooting</h2>
<table>
  <tr><th>Problem</th><th>What to do</th></tr>
  <tr><td>Gateway shows <b>offline</b></td><td>Check the phone is on the same Wi-Fi as the gateway. After the
  gateway restarts, give it up to 2 minutes. Tap the <i>offline</i> label to check again.</td></tr>
  <tr><td>Offline only sometimes, or only from some phones</td><td>A <b>Wi-Fi extender / repeater using the same
  network name</b> often blocks phones connected to it from reaching devices on the main router (and the other
  way round). Set the extender to <i>access point / mesh</i> mode, turn off its client isolation, or give it its
  own network name and keep the phone and the gateway on the same one.</td></tr>
  <tr><td>"Lock not reachable" / not connected</td><td>Touch the lock's keypad to wake it and try again. If the
  signal shows <i>Weak</i>, move the gateway closer.</td></tr>
  <tr><td>"Wrong connection password"</td><td>This is the lock's connection password, not a keypad PIN. If
  unknown, factory-reset the lock and add it as <b>New / reset lock</b>.</td></tr>
  <tr><td>"This PIN can't be used"</td><td>Choose a different PIN. The user keeps their old PIN until a change
  succeeds.</td></tr>
  <tr><td>"Lock refused user's PIN"</td><td>Lock &rarr; Settings &rarr; <i>App opens the door as</i>: pick the
  right user and enter their correct PIN.</td></tr>
  <tr><td>Door does not lock by itself</td><td>For app openings turn on <i>Also close after app unlock</i>. For
  keypad/finger/card openings fit the door magnet. Check <i>Normally open</i> is off.</td></tr>
  <tr><td>Temporary code doesn't work</td><td>Use it within its 5-minute window; press <span class="kbd">*</span>
  before and <span class="kbd">#</span> after the code; check the admin PIN entered in the app.</td></tr>
  <tr><td>No battery notifications</td><td>Allow notifications for Jenix Lock in Android settings; keep the phone
  on the gateway's Wi-Fi.</td></tr>
  <tr><td>Start the gateway setup again</td><td>Press the gateway's <b>RESET</b> button 10 times, about once per
  second (white blink each press, amber from the 5th). It restarts blinking purple. This clears only the gateway
  — the locks' users and fingerprints are kept.</td></tr>
</table>

<h2 id="safety">Safety</h2>
<ul>
  <li>Keep a physical key or keypad PIN as a backup way in.</li>
  <li>Keep the lock's connection password and admin PIN private; anyone with them can control the lock.</li>
  <li>Replace lock batteries when the app warns — the lock keeps working on its keypad, fingerprint and card
  even when the gateway or Wi-Fi is down.</li>
</ul>
"""


def nav_html() -> str:
    out = []
    for grp, items in NAV:
        out.append(f'      <div class="grp">{grp}</div>')
        out += [f'      <a href="#{i}">{t}</a>' for i, t in items]
    return "\n".join(out)


page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jenix Lock — User Guide</title>
<meta name="description" content="How to set up and use the Jenix Lock app and gateway: locks, users, door codes, alerts and attendance.">
{style}
{EXTRA_CSS}
</head>
<body>
<div class="layout">
  <aside>
    <div class="brand">
      <div class="logo">&#128274;</div>
      <div>
        <div class="n">Jenix Lock</div>
        <div class="s">User Guide</div>
      </div>
    </div>
    <nav>
{nav_html()}
    </nav>
  </aside>

  <main>
{SECTIONS}
  </main>
</div>
{footer}
</body>
</html>
"""

(DOCS / "jenix-lock-user-guide.html").write_text(page, encoding="utf-8")
print("wrote docs/jenix-lock-user-guide.html")
