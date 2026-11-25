import { useState } from "react";

import { api, ApiError } from "../services/api";
import type { Gateway, SavedLock } from "../services/store";
import { Sheet, Spinner } from "./Sheet";
import { useToast } from "./Toast";

export function AddUserSheet({ gw, lock, onClose, onAdded }: { gw: Gateway; lock: SavedLock; onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [group, setGroup] = useState<"admin" | "general">("general");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim()) {
      toast("Enter a name.", "err");
      return;
    }
    setBusy(true);
    try {
      const r = await api.addUser(gw, lock.lockId, name.trim(), group, pin.trim());
      toast(`Added user #${r.id}.`, "ok");
      onAdded();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Add failed.", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Add user" onClose={onClose}>
      <div className="field">
        <label>Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Role</label>
        <div className="seg">
          <button className={group === "general" ? "on" : ""} onClick={() => setGroup("general")}>
            General
          </button>
          <button className={group === "admin" ? "on" : ""} onClick={() => setGroup("admin")}>
            Admin
          </button>
        </div>
      </div>
      <div className="field">
        <label>PIN (optional)</label>
        <input className="input" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
      </div>
      <button className="btn primary" onClick={add} disabled={busy}>
        {busy ? <Spinner /> : "Add user"}
      </button>
    </Sheet>
  );
}
