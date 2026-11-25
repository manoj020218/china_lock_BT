import { useEffect, useState } from "react";

import { api, ApiError } from "../services/api";
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

      <div className="card">
        <div className="title" style={{ marginBottom: 10 }}>Firmware update (OTA)</div>
        <div className="field">
          <label>Firmware URL (LAN or VPS)</label>
          <input className="input" autoCapitalize="none" placeholder="http://…/firmware.bin" value={otaUrl} onChange={(e) => setOtaUrl(e.target.value)} />
        </div>
        <button className="btn" onClick={runOta} disabled={busy === "ota"}>
          {busy === "ota" ? <Spinner /> : "Update gateway"}
        </button>
        <div className="meta" style={{ marginTop: 8 }}>Wi-Fi, token and lock bindings are preserved across updates.</div>
      </div>

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
