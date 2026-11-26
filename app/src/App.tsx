import { useEffect, useState } from "react";
import { FiGrid, FiSettings } from "react-icons/fi";

import { App as CapApp } from "@capacitor/app";

import { askNotificationPermission, syncAlertConfig } from "./services/alerts";

import { GatewaySettingsSheet } from "./components/GatewaySettingsSheet";
import { ToastProvider } from "./components/Toast";
import { HomeScreen } from "./screens/HomeScreen";
import { LockScreen } from "./screens/LockScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import type { Gateway, SavedLock } from "./services/store";

type View = { tab: "home" | "settings" } | { tab: "lock"; lock: SavedLock };

export function App() {
  const [view, setView] = useState<View>({ tab: "home" });
  const [gwSettings, setGwSettings] = useState<Gateway | null>(null);
  const [homeKey, setHomeKey] = useState(0);

  const atRoot = view.tab === "home" || view.tab === "settings";

  // Android hardware back button.
  // Background low-battery checks: register once at start (asks for the
  // notification permission the first time).
  useEffect(() => {
    void syncAlertConfig();
    void askNotificationPermission();
  }, []);

  useEffect(() => {
    const sub = CapApp.addListener("backButton", ({ canGoBack }) => {
      if (gwSettings) setGwSettings(null);
      else if (view.tab === "lock") setView({ tab: "home" });
      else if (view.tab === "settings") setView({ tab: "home" });
      else if (!canGoBack) void CapApp.exitApp();
    });
    return () => {
      void sub.then((s) => s.remove());
    };
  }, [view, gwSettings]);

  return (
    <ToastProvider>
      <div className="app">
        {view.tab === "home" && (
          <HomeScreen
            key={homeKey}
            onOpenLock={(lock) => setView({ tab: "lock", lock })}
            onGatewaySettings={setGwSettings}
          />
        )}
        {view.tab === "settings" && <SettingsScreen />}
        {view.tab === "lock" && <LockScreen lock={view.lock} onBack={() => setView({ tab: "home" })} />}

        {atRoot && (
          <nav className="tabbar">
            <button className={view.tab === "home" ? "on" : ""} onClick={() => setView({ tab: "home" })}>
              <span className="ti">
                <FiGrid />
              </span>
              Locks
            </button>
            <button className={view.tab === "settings" ? "on" : ""} onClick={() => setView({ tab: "settings" })}>
              <span className="ti">
                <FiSettings />
              </span>
              Settings
            </button>
          </nav>
        )}

        {gwSettings && (
          <GatewaySettingsSheet
            gw={gwSettings}
            onClose={() => setGwSettings(null)}
            onChanged={() => setHomeKey((k) => k + 1)}
          />
        )}
      </div>
    </ToastProvider>
  );
}
