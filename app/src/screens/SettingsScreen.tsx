import { useState } from "react";

import { feedback, feedbackSettings } from "../feedback";

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
