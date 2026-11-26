import { useEffect, useRef, useState } from "react";
import { FiCheckCircle, FiLock, FiRefreshCw, FiWifi } from "react-icons/fi";

import { api, ApiError, type WifiNetworkDto } from "../services/api";
import { bindToWifi, discoverGateways, SETUP_HOST, unbindWifi } from "../services/net";
import { gateways, uid, type Gateway } from "../services/store";
import { SecretInput } from "./SecretInput";
import { Sheet, Spinner } from "./Sheet";
import { useToast } from "./Toast";

/**
 * "Set up new gateway" wizard (SoftAP provisioning):
 *   1. phone joins the gateway's "JenixLock-XXXX" Wi-Fi (192.168.4.1)
 *   2. user picks the home Wi-Fi + password; the gateway joins it and returns
 *      its API token and new LAN IP
 *   3. phone returns to home Wi-Fi; the app finds the gateway and saves it
 * The user never types an IP address or token.
 */

type Step = "join" | "wifi" | "joining" | "return" | "done";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function SetupGatewaySheet({
  onClose,
  onSaved,
  onManual
}: {
  onClose: () => void;
  onSaved: () => void;
  onManual: () => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState<Step>("join");
  const [busy, setBusy] = useState(false);
  const [apName, setApName] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [needsToken, setNeedsToken] = useState(false);
  const [token, setToken] = useState("");
  const [networks, setNetworks] = useState<WifiNetworkDto[] | null>(null);
  const [ssid, setSsid] = useState("");
  const [picked, setPicked] = useState(false); // a network was chosen: collapse the list
  const passRef = useRef<HTMLInputElement>(null);
  const [pass, setPass] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  const [saved, setSaved] = useState<Gateway | null>(null);
  const cancel = useRef({ cancelled: false });

  // Always restore normal routing when the wizard closes.
  useEffect(() => {
    const c = cancel.current;
    return () => {
      c.cancelled = true;
      void unbindWifi();
    };
  }, []);

  const setupGw = () => ({ host: SETUP_HOST, token: token.trim() });

  async function checkJoined() {
    setBusy(true);
    try {
      await bindToWifi();
      const h = await api.health({ host: SETUP_HOST, token: "" }, 5000);
      if (h.firmware !== "jenix-gateway") throw new Error("not a gateway");
      setApName(h.ap ?? "");
      setDeviceId(h.device_id ?? "");
      const existing = gateways.all().find((g) => g.deviceId && g.deviceId === h.device_id);
      if (existing) {
        setToken(existing.token);
        setName(existing.name);
      }
      setNeedsToken(h.setup === false && !existing);
      setStep("wifi");
      void scan(existing?.token ?? "", h.setup !== false || !!existing);
    } catch {
      toast("Gateway not found. Join its JenixLock-… Wi-Fi first.", "err");
    } finally {
      setBusy(false);
    }
  }

  async function scan(tok = token.trim(), allowed = !needsToken) {
    if (!allowed) return;
    setNetworks(null);
    try {
      const r = await api.wifiScan({ host: SETUP_HOST, token: tok });
      setNetworks(r.networks);
    } catch {
      setNetworks([]);
    }
  }

  async function provision() {
    if (!ssid.trim()) {
      toast("Choose your Wi-Fi network.", "err");
      return;
    }
    if (needsToken && !token.trim()) {
      toast("This gateway is already set up — enter its API token.", "err");
      return;
    }
    setBusy(true);
    let tok = token.trim();
    let devId = deviceId;
    try {
      const r = await api.provision(setupGw(), ssid.trim(), pass);
      tok = r.token;
      devId = r.device_id;
      setToken(tok);
      setDeviceId(devId);
    } catch (err) {
      setBusy(false);
      toast(err instanceof ApiError ? err.message : "Could not reach the gateway.", "err");
      return;
    }
    setStep("joining");
    setStatus(`Gateway is joining ${ssid.trim()}…`);

    // Poll the gateway (still reachable on its AP) for the result.
    const t0 = Date.now();
    let ip = "";
    while (!cancel.current.cancelled && Date.now() - t0 < 45000) {
      await sleep(1500);
      try {
        const s = await api.provisionStatus({ host: SETUP_HOST, token: tok });
        if (s.state === "connected" && s.ip) {
          ip = s.ip;
          break;
        }
        if (s.state === "failed") {
          setBusy(false);
          setStep("wifi");
          toast(s.error ? `Gateway: ${s.error}` : "Gateway could not join that Wi-Fi.", "err");
          return;
        }
      } catch {
        // The phone can drop off the AP while the gateway changes channel; keep trying.
      }
    }
    if (cancel.current.cancelled) return;

    // Close the setup AP so the phone falls back to the home Wi-Fi.
    if (ip) await api.provisionFinish({ host: SETUP_HOST, token: tok }).catch(() => undefined);
    await unbindWifi();
    setStep("return");
    setStatus(`Reconnect this phone to ${ssid.trim()}. Looking for the gateway…`);
    await findAndSave(tok, devId, ip);
  }

  async function findAndSave(tok: string, devId: string, ip: string) {
    setBusy(true);
    const t0 = Date.now();
    let host = "";
    while (!cancel.current.cancelled && Date.now() - t0 < 120000) {
      if (ip) {
        try {
          const h = await api.health({ host: ip, token: "" }, 2500);
          if (!devId || h.device_id === devId) {
            host = ip;
            break;
          }
        } catch {
          // phone not back on the home Wi-Fi yet
        }
      }
      // Every pass without a known IP (or if the IP did not answer) sweep the network.
      if (!ip || Date.now() - t0 > 20000) {
        const hits = await discoverGateways({ deviceId: devId, hints: ip ? [ip] : [], cancel: cancel.current });
        const hit = hits.find((x) => x.health.device_id === devId);
        if (hit) {
          host = hit.host;
          break;
        }
      }
      await sleep(2500);
    }
    if (cancel.current.cancelled) return;
    setBusy(false);
    if (!host) {
      setStatus(
        "Gateway not found yet. Make sure this phone is back on your home Wi-Fi, then retry. If you use a Wi-Fi extender/repeater with the same name, connect the phone to the main router (or switch the extender off for a moment) — many extenders block the phone from reaching devices on the main router."
      );
      return;
    }
    const existing = gateways.all().find((g) => g.deviceId === devId);
    const gw: Gateway = {
      id: existing?.id ?? uid(),
      name: name.trim() || existing?.name || "Gateway",
      host,
      token: tok,
      deviceId: devId
    };
    gateways.upsert(gw);
    setSaved(gw);
    setStep("done");
    toast("Gateway connected.", "ok");
  }

  return (
    <Sheet title="Set up new gateway" onClose={onClose}>
      {step === "join" && (
        <>
          <div className="card">
            <div className="title" style={{ marginBottom: 8 }}>
              1 · Connect to the gateway
            </div>
            <ol className="meta" style={{ paddingLeft: 18, lineHeight: 1.6, margin: 0 }}>
              <li>Power the gateway. A new gateway opens a Wi-Fi called <b>JenixLock-XXXX</b>.</li>
              <li>Open your phone's Wi-Fi settings and join <b>JenixLock-XXXX</b>.</li>
              <li>
                If Android says <i>"No internet"</i>, choose <b>Stay connected</b>.
              </li>
              <li>Come back here and tap the button below.</li>
            </ol>
          </div>
          <button className="btn primary" onClick={checkJoined} disabled={busy}>
            {busy ? <Spinner /> : "I've joined JenixLock-XXXX"}
          </button>
          <button className="btn ghost small" style={{ marginTop: 10 }} onClick={onManual}>
            Already on your Wi-Fi? Add manually
          </button>
        </>
      )}

      {step === "wifi" && (
        <>
          <div className="meta" style={{ marginBottom: 10 }}>
            Connected to <b>{apName || "the gateway"}</b>
            {deviceId && <> · ID {deviceId}</>}
          </div>
          {needsToken && (
            <div className="field">
              <label>API token (this gateway was set up before)</label>
              <input
                className="input"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="or press its RESET button 10× to start fresh"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onBlur={() => token.trim() && void scan(token.trim(), true)}
              />
            </div>
          )}
          {picked ? (
            <div className="card">
              <div className="row">
                <FiWifi />
                <div className="grow" style={{ marginLeft: 8 }}>
                  <div className="meta">Home Wi-Fi</div>
                  <div className="title">{ssid}</div>
                </div>
                <button className="btn ghost small" style={{ width: "auto" }} onClick={() => setPicked(false)}>
                  Change
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="card">
                <div className="row" style={{ marginBottom: 6 }}>
                  <div className="grow title">2 · Choose your home Wi-Fi</div>
                  <button
                    className="iconbtn"
                    aria-label="Rescan"
                    onClick={() => void scan(token.trim(), !needsToken || !!token.trim())}
                  >
                    <FiRefreshCw />
                  </button>
                </div>
                {networks === null && !needsToken && <Spinner />}
                {networks?.length === 0 && <div className="meta">No networks found — type the name below.</div>}
                {/* Bounded list so the password + Connect stay in reach. */}
                <div style={{ maxHeight: "32vh", overflowY: "auto" }}>
                  {networks?.map((n) => (
                    <button
                      key={n.ssid}
                      className="listrow"
                      style={{ width: "100%", textAlign: "left" }}
                      onClick={() => {
                        setSsid(n.ssid);
                        setPicked(true);
                        setTimeout(() => {
                          passRef.current?.focus();
                          passRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
                        }, 50);
                      }}
                    >
                      <FiWifi style={{ opacity: n.rssi > -65 ? 1 : 0.5 }} />
                      <div className="grow title" style={{ marginLeft: 8 }}>
                        {n.ssid}
                      </div>
                      {n.secure && <FiLock style={{ opacity: 0.6 }} />}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>…or type the Wi-Fi name</label>
                <input
                  className="input"
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={ssid}
                  onChange={(e) => setSsid(e.target.value)}
                />
              </div>
            </>
          )}
          <div className="field">
            <label>Wi-Fi password</label>
            <SecretInput ref={passRef} placeholder="8+ characters" value={pass} onChange={(e) => setPass(e.target.value)} />
          </div>
          <div className="field">
            <label>Gateway name</label>
            <input className="input" placeholder="Front door gateway" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="meta" style={{ marginBottom: 10 }}>The gateway supports 2.4 GHz Wi-Fi only.</div>
          <button className="btn primary" onClick={provision} disabled={busy}>
            {busy ? <Spinner /> : "Connect gateway"}
          </button>
        </>
      )}

      {(step === "joining" || step === "return") && (
        <div className="card" style={{ textAlign: "center" }}>
          {busy && <Spinner />}
          <div className="title" style={{ marginTop: 10 }}>
            {step === "joining" ? "Connecting…" : "3 · Back to your Wi-Fi"}
          </div>
          <div className="meta" style={{ marginTop: 6 }}>
            {status}
          </div>
          {step === "return" && !busy && (
            <button className="btn primary" style={{ marginTop: 14 }} onClick={() => void findAndSave(token, deviceId, "")}>
              Search again
            </button>
          )}
        </div>
      )}

      {step === "done" && saved && (
        <>
          <div className="card" style={{ textAlign: "center" }}>
            <FiCheckCircle style={{ fontSize: 40, color: "var(--ok, #22c55e)" }} />
            <div className="title" style={{ marginTop: 8 }}>
              {saved.name} is ready
            </div>
            <div className="meta" style={{ marginTop: 4 }}>
              Found at {saved.host}. If its address changes, the app finds it again automatically.
            </div>
          </div>
          <button className="btn primary" onClick={onSaved}>
            Done
          </button>
        </>
      )}
    </Sheet>
  );
}
