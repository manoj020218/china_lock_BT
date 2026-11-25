import { useCallback, useEffect, useState } from "react";
import { FiPlus, FiRadio, FiServer, FiSettings, FiWifi, FiWifiOff } from "react-icons/fi";

import { AddGatewaySheet } from "../components/AddGatewaySheet";
import { ScanBindSheet } from "../components/ScanBindSheet";
import { Spinner } from "../components/Sheet";
import { api } from "../services/api";
import { gateways, locks, type Gateway, type SavedLock } from "../services/store";

type Health = "checking" | "online" | "offline";

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
  const mine = locks.forGateway(gw.id);

  useEffect(() => {
    let alive = true;
    setHealth("checking");
    api
      .health(gw)
      .then(() => alive && setHealth("online"))
      .catch(() => alive && setHealth("offline"));
    return () => {
      alive = false;
    };
  }, [gw, refreshToken]);

  return (
    <div className="card">
      <div className="row">
        <div className="iconbtn">
          <FiServer />
        </div>
        <div className="grow">
          <div className="title">{gw.name}</div>
          <div className="meta">{gw.host}</div>
        </div>
        {health === "checking" ? (
          <Spinner />
        ) : health === "online" ? (
          <span className="pill ok">
            <FiWifi style={{ verticalAlign: "-2px" }} /> online
          </span>
        ) : (
          <span className="pill bad">
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
            <span className="pill">open ›</span>
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
  const [scanGw, setScanGw] = useState<Gateway | null>(null);
  const [refresh, setRefresh] = useState(0);

  const reload = useCallback(() => {
    setList(gateways.all());
    setRefresh((n) => n + 1);
  }, []);

  return (
    <div className="screen">
      <div className="appbar">
        <div className="grow">
          <h1>Jenix Lock</h1>
          <div className="sub">Gateways &amp; locks</div>
        </div>
        <button className="iconbtn" aria-label="Add gateway" onClick={() => setAddGw(true)}>
          <FiPlus />
        </button>
      </div>

      {list.length === 0 ? (
        <div className="empty">
          <div className="big">🔐</div>
          <div className="title">No gateways yet</div>
          <div className="meta" style={{ marginTop: 6 }}>
            Add your ESP32-S3 gateway to control its locks over Wi-Fi.
          </div>
          <button className="btn primary" style={{ marginTop: 18, maxWidth: 240 }} onClick={() => setAddGw(true)}>
            <FiPlus /> Add gateway
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

      {addGw && <AddGatewaySheet onClose={() => setAddGw(false)} onSaved={() => { setAddGw(false); reload(); }} />}
      {scanGw && (
        <ScanBindSheet gw={scanGw} onClose={() => setScanGw(null)} onBound={() => { setScanGw(null); reload(); }} />
      )}
    </div>
  );
}
