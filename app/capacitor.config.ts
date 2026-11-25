import type { CapacitorConfig } from "@capacitor/cli";

// Plain http scheme + cleartext so the WebView can reach the gateway over the
// LAN at http://<gateway-ip> (the ESP32-S3 serves plain HTTP on the local net).
const config: CapacitorConfig = {
  appId: "one.jenix.lock",
  appName: "Jenix Lock",
  webDir: "dist",
  server: { androidScheme: "http", cleartext: true },
  android: { allowMixedContent: true }
};

export default config;
