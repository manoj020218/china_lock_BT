import { useCallback, useEffect, useState } from "react";
import { FiPlus, FiRadio, FiServer, FiSettings, FiWifi, FiWifiOff } from "react-icons/fi";

import { AddGatewaySheet } from "../components/AddGatewaySheet";
import { ScanBindSheet } from "../components/ScanBindSheet";
import { SetupGatewaySheet } from "../components/SetupGatewaySheet";
import { Spinner } from "../components/Sheet";
import { useToast } from "../components/Toast";
import { api } from "../services/api";
import { alarmOnce, LOW_BATTERY, syncAlertConfig } from "../services/alerts";
import { bundledFirmware, updateAvailable } from "../services/firmware";
import { resolveGateway } from "../services/net";
import { gateways, locks, type Gateway, type SavedLock } from "../services/store";

type Health = "checking" | "searching" | "online" | "offline";

function GatewayCard({
  gw,
  onAddLock,
  onOpenLock,
  onGatewaySettings,
  refreshToken
}: {
  gw: Gateway;
  onAddLock: (gw: Gateway) => void;
  onOpenLock: (l: SavedLock) => void;
  onGatewaySettings: (gw: Gateway) => void;
  refreshToken: number;
}) {
  const [health, setHealth] = useState<Health>("checking");
  const [host, setHost] = useState(gw.host);
  const [boundIds, setBoundIds] = useState<Set<string> | null>(null);
  const [recheck, setRecheck] = useState(0); // bump to check the gateway again
  const [battery, setBattery] = useState<Record<string, number>>({});
  const [fwUpdate, setFwUpdate] = useState(false);
  const toast = useToast();
  const mine = locks.forGateway(gw.id);

  // Check the saved IP; if the gateway moved (DHCP), find it by device_id.
  useEffect(() => {
    let alive = true;
    // Quiet re-checks keep the current badge instead of flashing a spinner.
    if (recheck === 0) setHealth("checking");
    const slow = setTimeout(() => alive && gw.deviceId && setHealth("searching"), 4500);
    resolveGateway(gw)
      .then((r) => {
        if (!alive) return;
        if (r) {
          setHost(r.gw.host);
          setHealth("online");
          void bundledFirmware().then((b) => alive && setFwUpdate(updateAvailable(r.health.fw_version ?? null, b)));
          // Which saved locks does the gateway actually know?
          api
            .locks(r.gw)
            .then((l) => alive && setBoundIds(new Set(l.locks.map((x) => x.lock_id.toUpperCase()))))
            .catch(() => undefined);
          // Low-battery: badge + alarm (sound + vibration) once per session.
          api
            .alerts(r.gw)
            .then((a) => {
              if (!alive) return;
              const map: Record<string, number> = {};
              for (const x of a.locks) if (x.battery >= 0) map[x.lock_id.toUpperCase()] = x.battery;
              setBattery(map);
              for (const x of a.locks) {
                if (!x.low) continue;
                const saved = mine.find((m) => m.lockId.toUpperCase() === x.lock_id.toUpperCase());
                if (saved && alarmOnce(x.lock_id)) toast(`🔋 ${saved.name}: battery ${x.battery}% — replace soon`, "err");
              }
            })
            .catch(() => undefined);
        } else setHealth("offline");
      })
      .catch(() => alive && setHealth("offline"))
      .finally(() => clearTimeout(slow));
    return () => {
      alive = false;
      clearTimeout(slow);
    };
  }, [gw, refreshToken, recheck]);

  // Never leave a stale "offline": re-check every 15 s while offline, and
  // whenever the app comes back to the foreground.
  useEffect(() => {
    const again = () => setRecheck((n) => n + 1);
    const t = health === "offline" ? window.setInterval(again, 15000) : undefined;
    const onVis = () => {
      if (!document.hidden) again();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (t) window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [health]);

  return (
    <div className="card">
      <div className="row">
        <div className="iconbtn">
          <FiServer />
        </div>
        <div className="grow">
          <div className="title">
            {gw.name}
            {fwUpdate && (
              <span
                className="pill warn"
                style={{ marginLeft: 8, fontSize: 11, cursor: "pointer" }}
                onClick={() => onGatewaySettings(gw)}
                title="New gateway firmware in this app"
              >
                update available
              </span>
            )}
          </div>
          <div className="meta">{health === "searching" ? "searching the network…" : host}</div>
        </div>
        {health === "checking" || health === "searching" ? (
          <Spinner />
        ) : health === "online" ? (
          <span className="pill ok">
            <FiWifi style={{ verticalAlign: "-2px" }} /> online
          </span>
        ) : (
          <span
            className="pill bad"
            role="button"
            title="Tap to check again"
            style={{ cursor: "pointer" }}
            onClick={() => {
              setHealth("checking");
              setRecheck((n) => n + 1);
            }}
          >
            <FiWifiOff style={{ verticalAlign: "-2px" }} /> offline
          </span>
        )}
        <button className="iconbtn" aria-label="Gateway settings" onClick={() => onGatewaySettings(gw)}>
          <FiSettings />
        </button>
      </div>

      <div style={{ marginTop: 8 }}>
        {mine.length === 0 && <div className="meta" style={{ padding: "10px 4px" }}>No locks yet.</div>}
        {mine.map((l) => (
          <button key={l.lockId} className="listrow" style={{ width: "100%", textAlign: "left" }} onClick={() => onOpenLock(l)}>
            <div className="grow">
              <div className="title">{l.name}</div>
              <div className="meta">{l.lockId}</div>
            </div>
            {battery[l.lockId.toUpperCase()] !== undefined && (
              <span
                className={`pill ${battery[l.lockId.toUpperCase()] < LOW_BATTERY ? "bad" : ""}`}
                style={{ marginRight: 6 }}
                title="Lock battery"
              >
                🔋 {battery[l.lockId.toUpperCase()]}%
              </span>
            )}
            {boundIds && !boundIds.has(l.lockId.toUpperCase()) ? (
              <span className="pill bad">not set up</span>
            ) : (
              <span className="pill">open ›</span>
            )}
          </button>
        ))}
      </div>

      <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => onAddLock(gw)}>
        <FiRadio /> Scan &amp; add a lock
      </button>
    </div>
  );
}

export function HomeScreen({
  onOpenLock,
  onGatewaySettings
}: {
  onOpenLock: (l: SavedLock) => void;
  onGatewaySettings: (gw: Gateway) => void;
}) {
  const [list, setList] = useState<Gateway[]>(gateways.all());
  const [addGw, setAddGw] = useState(false);
  const [setupGw, setSetupGw] = useState(false);
  const [scanGw, setScanGw] = useState<Gateway | null>(null);
  const [refresh, setRefresh] = useState(0);

  const reload = useCallback(() => {
    setList(gateways.all());
    setRefresh((n) => n + 1);
    void syncAlertConfig();
  }, []);

  return (
    <div className="screen">
      <div className="appbar">
        <div className="grow">
          <h1>Jenix Lock</h1>
          <div className="sub">Gateways &amp; locks</div>
        </div>
        <button className="iconbtn" aria-label="Add gateway" onClick={() => setSetupGw(true)}>
          <FiPlus />
        </button>
      </div>

      {list.length === 0 ? (
        <div className="empty">
          <div className="big">🔐</div>
          <div className="title">No gateways yet</div>
          <div className="meta" style={{ marginTop: 6 }}>
            Set up your Jenix gateway to control its locks over Wi-Fi.
          </div>
          <button className="btn primary" style={{ marginTop: 18, maxWidth: 260 }} onClick={() => setSetupGw(true)}>
            <FiPlus /> Set up new gateway
          </button>
          <button className="btn ghost small" style={{ marginTop: 10, maxWidth: 260 }} onClick={() => setAddGw(true)}>
            Add an existing gateway
          </button>
        </div>
      ) : (
        list.map((gw) => (
          <GatewayCard
            key={gw.id}
            gw={gw}
            refreshToken={refresh}
            onAddLock={setScanGw}
            onOpenLock={onOpenLock}
            onGatewaySettings={onGatewaySettings}
          />
        ))
      )}

      {setupGw && (
        <SetupGatewaySheet
          onClose={() => setSetupGw(false)}
          onSaved={() => {
            setSetupGw(false);
            reload();
          }}
          onManual={() => {
            setSetupGw(false);
            setAddGw(true);
          }}
        />
      )}
      {addGw && <AddGatewaySheet onClose={() => setAddGw(false)} onSaved={() => { setAddGw(false); reload(); }} />}
      {scanGw && (
        <ScanBindSheet gw={scanGw} onClose={() => setScanGw(null)} onBound={() => { setScanGw(null); reload(); }} />
      )}
    </div>
  );
}
