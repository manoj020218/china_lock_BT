import { useState } from "react";

import { api, ApiError } from "../services/api";
import { discoverGateways, type FoundGateway } from "../services/net";
import { gateways, uid, type Gateway } from "../services/store";
import { Sheet, Spinner } from "./Sheet";
import { useToast } from "./Toast";

/**
 * Add or edit a gateway (one ESP32-S3) that is already on the Wi-Fi. "Find on
 * this network" fills the address automatically; the token is still needed
 * (new gateways should use "Set up new gateway", which receives it).
 * Tests the connection before saving so a wrong IP or token is caught.
 */
export function AddGatewaySheet({ edit, onClose, onSaved }: { edit?: Gateway; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(edit?.name ?? "");
  const [host, setHost] = useState(edit?.host ?? "");
  const [token, setToken] = useState(edit?.token ?? "");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<FoundGateway[] | null>(null);
  const [searching, setSearching] = useState(false);

  async function search() {
    setSearching(true);
    setFound([]);
    const hits = await discoverGateways({
      hints: gateways.all().map((g) => g.host),
      onFound: (g) => setFound((cur) => [...(cur ?? []), g])
    });
    setFound(hits);
    setSearching(false);
    if (hits.length === 0) toast("No gateway found on this Wi-Fi.", "err");
  }

  async function save() {
    const h = host.trim();
    const t = token.trim();
    if (!h || !t) {
      toast("Enter the gateway IP and API token.", "err");
      return;
    }
    setBusy(true);
    try {
      const health = await api.health({ host: h, token: t });
      // health has no auth; verify the token with an authenticated call.
      await api.locks({ host: h, token: t });
      const gw: Gateway = {
        id: edit?.id ?? uid(),
        name: name.trim() || `Gateway ${h}`,
        host: h,
        token: t,
        deviceId: health.device_id ?? edit?.deviceId
      };
      gateways.upsert(gw);
      toast(`Connected — ${health.locks} lock(s) bound.`, "ok");
      onSaved();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not connect.";
      toast(msg, "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={edit ? "Edit gateway" : "Add gateway"} onClose={onClose}>
      <div className="field">
        <label>Name</label>
        <input className="input" placeholder="Front door gateway" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <button className="btn ghost small" style={{ marginBottom: 10 }} onClick={search} disabled={searching}>
        {searching ? <Spinner /> : "Find on this network"}
      </button>
      {found?.map((g) => (
        <button
          key={g.health.device_id ?? g.host}
          className="listrow"
          style={{ width: "100%", textAlign: "left" }}
          onClick={() => setHost(g.host)}
        >
          <div className="grow">
            <div className="title">{g.host}</div>
            <div className="meta">
              ID {g.health.device_id ?? "?"} · {g.health.locks} lock(s)
            </div>
          </div>
          {host === g.host && <span className="pill ok">selected</span>}
        </button>
      ))}
      <div className="field">
        <label>Gateway IP / host</label>
        <input
          className="input"
          placeholder="filled by Find, or e.g. 192.168.1.217"
          autoCapitalize="none"
          autoCorrect="off"
          value={host}
          onChange={(e) => setHost(e.target.value)}
        />
      </div>
      <div className="field">
        <label>API token</label>
        <input
          className="input"
          placeholder="from the phone that set it up / serial TOKEN"
          autoCapitalize="none"
          autoCorrect="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      <button className="btn primary" onClick={save} disabled={busy}>
        {busy ? <Spinner /> : edit ? "Save changes" : "Test & add"}
      </button>
    </Sheet>
  );
}
