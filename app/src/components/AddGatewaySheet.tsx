import { useState } from "react";

import { api, ApiError } from "../services/api";
import { gateways, uid, type Gateway } from "../services/store";
import { Sheet, Spinner } from "./Sheet";
import { useToast } from "./Toast";

/**
 * Add or edit a gateway (one ESP32-S3). Tests the connection against
 * /api/health before saving so a wrong IP or token is caught immediately.
 */
export function AddGatewaySheet({ edit, onClose, onSaved }: { edit?: Gateway; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(edit?.name ?? "");
  const [host, setHost] = useState(edit?.host ?? "");
  const [token, setToken] = useState(edit?.token ?? "");
  const [busy, setBusy] = useState(false);

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
      const gw: Gateway = { id: edit?.id ?? uid(), name: name.trim() || `Gateway ${h}`, host: h, token: t };
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
      <div className="field">
        <label>Gateway IP / host</label>
        <input
          className="input"
          placeholder="192.168.1.217 or jenixlock.local"
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
          placeholder="printed at boot / serial TOKEN"
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
