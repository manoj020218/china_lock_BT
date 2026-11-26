import { useState } from "react";

import { Spinner } from "../components/Sheet";
import { useToast } from "../components/Toast";
import { feedback, feedbackSettings } from "../feedback";
import { askNotificationPermission, LOW_BATTERY, syncAlertConfig, testNotification } from "../services/alerts";
import { api, ApiError } from "../services/api";
import { gateways } from "../services/store";

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="listrow">
      <div className="grow title">{label}</div>
      <button
        role="switch"
        aria-checked={value}
        className="btn small"
        style={{ width: "auto" }}
        onClick={() => onChange(!value)}
      >
        {value ? "On" : "Off"}
      </button>
    </div>
  );
}

export function SettingsScreen() {
  const [sounds, setSounds] = useState(feedbackSettings.sounds);
  const [haptics, setHaptics] = useState(feedbackSettings.haptics);
  const [checking, setChecking] = useState(false);
  const toast = useToast();

  async function testAlert() {
    const ok = await askNotificationPermission();
    if (!ok) {
      toast("Allow notifications for Jenix Lock in Android settings.", "err");
      return;
    }
    await syncAlertConfig();
    await testNotification("Test lock");
    toast("Test notification sent.", "ok");
  }

  async function checkNow() {
    setChecking(true);
    try {
      for (const g of gateways.all()) await api.alertsCheck(g);
      toast("Batteries measured — see the badges on the Locks screen.", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Check failed.", "err");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="screen">
      <div className="appbar">
        <div className="grow">
          <h1>Settings</h1>
          <div className="sub">App v{__APP_VERSION__}</div>
        </div>
      </div>

      <div className="card">
        <div className="title" style={{ marginBottom: 6 }}>Feedback</div>
        <Toggle
          label="Button sounds"
          value={sounds}
          onChange={(v) => {
            feedbackSettings.sounds = v;
            setSounds(v);
            if (v) feedback("confirm");
          }}
        />
        <Toggle
          label="Haptics (vibration)"
          value={haptics}
          onChange={(v) => {
            feedbackSettings.haptics = v;
            setHaptics(v);
            if (v) feedback("tap");
          }}
        />
      </div>

      <div className="card">
        <div className="title" style={{ marginBottom: 4 }}>Low-battery alerts</div>
        <div className="meta" style={{ marginBottom: 10, lineHeight: 1.5 }}>
          The gateway checks every lock's battery a few times a day. Below {LOW_BATTERY}% this phone alerts you with a
          sound and vibration — in the app, and as a notification when the app is in the background or closed (while the
          phone is on the same Wi-Fi as the gateway).
        </div>
        <div className="btn-row">
          <button className="btn small" onClick={testAlert}>
            Test alert
          </button>
          <button className="btn small" onClick={checkNow} disabled={checking}>
            {checking ? <Spinner /> : "Check batteries now"}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="title" style={{ marginBottom: 8 }}>About</div>
        <div className="meta" style={{ lineHeight: 1.6 }}>
          Jenix Lock controls HAHA/Jenix BLE locks through an ESP32-S3 gateway on your Wi-Fi. Each gateway can manage several
          locks. Commands run only when the lock is in radio range of its gateway — a weak-signal error means the command did
          not reach the lock.
        </div>
      </div>
    </div>
  );
}
