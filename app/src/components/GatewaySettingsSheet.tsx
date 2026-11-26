import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../services/api";
import { bundledFirmware, installedVersion, updateAvailable, uploadFirmware, waitForVersion, type BundledFirmware } from "../services/firmware";
import { gateways, type Gateway } from "../services/store";
import { AddGatewaySheet } from "./AddGatewaySheet";
import { Sheet, Spinner } from "./Sheet";
import { useToast } from "./Toast";

/**
 * Per-gateway settings: cloud (MQTT) config, OTA firmware pull, edit/remove.
 */
export function GatewaySettingsSheet({ gw, onClose, onChanged }: { gw: Gateway; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [cloud, setCloud] = useState<Record<string, unknown> | null>(null);
  const [otaUrl, setOtaUrl] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    api
      .cloudGet(gw)
      .then(setCloud)
      .catch(() => setCloud({}));
  }, [gw]);

  async function saveCloud() {
    setBusy("cloud");
    try {
      await api.cloudSet(gw, {
        enabled: !!cloud?.enabled,
        host: String(cloud?.host ?? ""),
        port: Number(cloud?.port ?? 1883),
        client_id: String(cloud?.client_id ?? ""),
        user: String(cloud?.user ?? ""),
        pass: String(cloud?.pass ?? "")
      });
      toast("Cloud settings saved.", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed.", "err");
    } finally {
      setBusy("");
    }
  }

  async function runOta() {
    if (!otaUrl.trim()) {
      toast("Enter a firmware URL.", "err");
      return;
    }
    if (!window.confirm("Update the gateway firmware from this URL? It will reboot. Lock bindings are preserved.")) return;
    setBusy("ota");
    try {
      await api.ota(gw, otaUrl.trim());
      toast("Update started — the gateway will reboot.", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "OTA failed.", "err");
    } finally {
      setBusy("");
    }
  }

  function remove() {
    if (!window.confirm(`Remove ${gw.name} and its saved locks from this app?`)) return;
    gateways.remove(gw.id);
    onChanged();
    onClose();
  }

  const cv = (k: string) => String(cloud?.[k] ?? "");

  return (
    <Sheet title={gw.name} onClose={onClose}>
      <button className="btn" onClick={() => setEditing(true)}>
        Edit connection
      </button>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="grow title">Cloud (MQTT)</div>
          <button
            role="switch"
            aria-checked={!!cloud?.enabled}
            className="btn small"
            style={{ width: "auto" }}
            onClick={() => setCloud({ ...cloud, enabled: !cloud?.enabled })}
          >
            {cloud?.enabled ? "On" : "Off"}
          </button>
        </div>
        {!cloud ? (
          <Spinner />
        ) : (
          <>
            <div className="field">
              <label>Broker host</label>
              <input className="input" autoCapitalize="none" value={cv("host")} onChange={(e) => setCloud({ ...cloud, host: e.target.value })} />
            </div>
            <div className="row" style={{ gap: 10 }}>
              <div className="field grow">
                <label>Port</label>
                <input className="input" inputMode="numeric" value={cv("port") || "1883"} onChange={(e) => setCloud({ ...cloud, port: e.target.value })} />
              </div>
              <div className="field grow">
                <label>Client ID</label>
                <input className="input" autoCapitalize="none" value={cv("client_id")} onChange={(e) => setCloud({ ...cloud, client_id: e.target.value })} />
              </div>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <div className="field grow">
                <label>User</label>
                <input className="input" autoCapitalize="none" value={cv("user")} onChange={(e) => setCloud({ ...cloud, user: e.target.value })} />
              </div>
              <div className="field grow">
                <label>Password</label>
                <input className="input" value={cv("pass")} onChange={(e) => setCloud({ ...cloud, pass: e.target.value })} />
              </div>
            </div>
            <button className="btn primary" onClick={saveCloud} disabled={busy === "cloud"}>
              {busy === "cloud" ? <Spinner /> : "Save cloud settings"}
            </button>
          </>
        )}
      </div>

      <RadioCard gw={gw} />

      <FirmwareCard gw={gw} onUpdated={onChanged} />

      <details className="card">
        <summary className="meta" style={{ cursor: "pointer" }}>Advanced: update from a URL</summary>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Firmware URL (LAN or VPS, http)</label>
          <input className="input" autoCapitalize="none" placeholder="http://…/firmware.bin" value={otaUrl} onChange={(e) => setOtaUrl(e.target.value)} />
        </div>
        <button className="btn" onClick={runOta} disabled={busy === "ota"}>
          {busy === "ota" ? <Spinner /> : "Update from URL"}
        </button>
      </details>

      <button className="btn danger" onClick={remove}>
        Remove gateway
      </button>

      {editing && (
        <AddGatewaySheet
          edit={gw}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </Sheet>
  );
}

const WIFI_LEVELS = [
  { dbm: 11, label: "Normal" },
  { dbm: 15, label: "High" }
];
const BLE_LEVELS = [
  { dbm: 9, label: "Normal" },
  { dbm: 15, label: "High" }
];

/**
 * Gateway transmit power. Higher power = more range but more current: "High"
 * and "Max" need a good 5 V / 2 A adapter. If the gateway browns out it steps
 * the power back down by itself.
 */
function RadioCard({ gw }: { gw: Gateway }) {
  const toast = useToast();
  const [cfg, setCfg] = useState<{ wifi_dbm: number; ble_dbm: number; wifi_rssi: number; stepped_down: boolean } | null>(
    null
  );
  const [wifi, setWifi] = useState(11);
  const [ble, setBle] = useState(9);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .radioGet(gw)
      .then((r) => {
        setCfg(r);
        setWifi(r.wifi_dbm);
        setBle(r.ble_dbm);
      })
      .catch(() => setCfg(null));
  }, [gw]);

  async function save() {
    setBusy(true);
    try {
      const r = await api.radioSet(gw, { wifi_dbm: wifi, ble_dbm: ble });
      setCfg(r);
      toast("Radio power saved.", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed (update the gateway firmware?).", "err");
    } finally {
      setBusy(false);
    }
  }

  const seg = (levels: { dbm: number; label: string }[], value: number, set: (n: number) => void) => (
    <div className="seg">
      {levels.map((l) => (
        <button key={l.dbm} className={value === l.dbm ? "on" : ""} onClick={() => set(l.dbm)}>
          {l.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="card">
      <div className="title" style={{ marginBottom: 4 }}>Radio power (range)</div>
      <div className="meta" style={{ marginBottom: 10 }}>
        Higher power reaches further. Use <b>High</b> only with a good 5 V / 2 A adapter — if the gateway restarts
        from low power it steps back down by itself.
      </div>
      {!cfg ? (
        <div className="meta">Not available — update the gateway firmware.</div>
      ) : (
        <>
          {cfg.stepped_down && (
            <div className="meta" style={{ color: "#ffb648", marginBottom: 8 }}>
              ⚠️ Power was reduced automatically after a power dip. Check the adapter before raising it again.
            </div>
          )}
          <label className="meta">Wi-Fi ({wifi} dBm)</label>
          {seg(WIFI_LEVELS, wifi, setWifi)}
          <label className="meta" style={{ display: "block", marginTop: 10 }}>
            Bluetooth to locks (+{ble} dBm)
          </label>
          {seg(BLE_LEVELS, ble, setBle)}
          <div className="meta" style={{ margin: "8px 0" }}>
            Gateway Wi-Fi signal now: {cfg.wifi_rssi ? `${cfg.wifi_rssi} dBm` : "—"}
          </div>
          <button
            className="btn primary"
            onClick={save}
            disabled={busy || (wifi === cfg.wifi_dbm && ble === cfg.ble_dbm)}
          >
            {busy ? <Spinner /> : "Save radio power"}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * One-tap gateway firmware update using the build bundled in this app.
 */
function FirmwareCard({ gw, onUpdated }: { gw: Gateway; onUpdated: () => void }) {
  const toast = useToast();
  const [bundled, setBundled] = useState<BundledFirmware | null | undefined>(undefined);
  const [installed, setInstalled] = useState<string | null | undefined>(undefined);
  const [phase, setPhase] = useState<"idle" | "uploading" | "restarting" | "done" | "failed">("idle");
  const [progress, setProgress] = useState(0);
  const [note, setNote] = useState("");

  const refresh = useCallback(() => {
    void bundledFirmware().then(setBundled);
    installedVersion(gw)
      .then(setInstalled)
      .catch(() => setInstalled(undefined));
  }, [gw]);

  useEffect(refresh, [refresh]);

  const canUpdate = updateAvailable(installed ?? null, bundled ?? null) && installed !== undefined;

  async function update() {
    if (!bundled) return;
    if (!window.confirm(`Install gateway firmware v${bundled.version}? The gateway restarts (about 1 minute). Wi-Fi, locks and settings are kept.`))
      return;
    setPhase("uploading");
    setProgress(0);
    setNote("");
    try {
      try {
        await uploadFirmware(gw, bundled, setProgress);
      } catch (err) {
        // A dropped connection after the whole file was sent usually means the
        // gateway already installed it and restarted; verify below.
        if (!(err instanceof Error && err.message === "upload-connection-lost")) throw err;
      }
      setPhase("restarting");
      const ok = await waitForVersion(gw, bundled.version);
      if (ok) {
        setPhase("done");
        setInstalled(bundled.version);
        toast(`Gateway updated to v${bundled.version}.`, "ok");
        onUpdated(); // refresh the home screen (clears the "update available" chip)
      } else {
        setPhase("failed");
        setNote("The gateway didn't come back on the new version. It keeps running the old firmware — try again.");
      }
    } catch (err) {
      setPhase("failed");
      setNote(err instanceof Error ? err.message : "Update failed.");
    }
  }

  return (
    <div className="card">
      <div className="title" style={{ marginBottom: 8 }}>Gateway firmware</div>
      <div className="listrow">
        <div className="grow meta">Installed</div>
        <div className="title">
          {installed === undefined ? "…" : installed ? `v${installed}` : "older (before 1.2)"}
        </div>
      </div>
      <div className="listrow">
        <div className="grow meta">In this app</div>
        <div className="title">{bundled === undefined ? "…" : bundled ? `v${bundled.version}` : "none"}</div>
      </div>

      {phase === "uploading" && (
        <div style={{ margin: "12px 0" }}>
          <div className="meta" style={{ marginBottom: 6 }}>Sending firmware… {Math.round(progress * 100)}%</div>
          <div style={{ height: 8, borderRadius: 4, background: "rgba(255,255,255,0.12)", overflow: "hidden" }}>
            <div style={{ width: `${progress * 100}%`, height: "100%", background: "linear-gradient(90deg,#6ea8ff,#9b7bff)" }} />
          </div>
          <div className="meta" style={{ marginTop: 6 }}>Keep the app open and the phone on the same Wi-Fi.</div>
        </div>
      )}
      {phase === "restarting" && (
        <div className="center" style={{ margin: "12px 0" }}>
          <Spinner /> Installed — waiting for the gateway to restart…
        </div>
      )}
      {phase === "failed" && note && <div className="meta" style={{ color: "#f87171", margin: "10px 0" }}>{note}</div>}

      {installed === null && phase === "idle" && (
        <div className="meta" style={{ margin: "8px 0", color: "#ffb648" }}>
          This gateway's firmware is too old for in-app updates. Update it once by USB (or "update from a URL" below);
          after that, updates come with the app.
        </div>
      )}
      {phase !== "uploading" && phase !== "restarting" && (
        <button
          className={`btn ${canUpdate ? "primary" : ""}`}
          style={{ marginTop: 10 }}
          onClick={update}
          disabled={!canUpdate || installed === null}
        >
          {canUpdate && installed !== null
            ? `Update gateway to v${bundled?.version}`
            : phase === "done" || (installed && bundled && !canUpdate)
              ? "Gateway is up to date ✓"
              : "No update available"}
        </button>
      )}
    </div>
  );
}
