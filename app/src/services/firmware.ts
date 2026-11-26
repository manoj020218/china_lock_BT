/**
 * Gateway firmware updates from the app.
 *
 * Each app build bundles the latest gateway firmware (public/firmware/, made
 * by scripts/bundle-firmware.mjs). The app compares it with the version the
 * gateway reports (/api/health "fw_version") and, on request, uploads the
 * file straight to the gateway (POST /api/ota/upload), then waits for the
 * gateway to restart on the new version.
 */

import { api, type GatewayTarget } from "./api";

export interface BundledFirmware {
  version: string;
  size: number;
  md5: string;
  file: string;
  built: string;
}

let cached: BundledFirmware | null | undefined;

/** The firmware shipped inside this app, or null if none was bundled. */
export async function bundledFirmware(): Promise<BundledFirmware | null> {
  if (cached !== undefined) return cached;
  try {
    const r = await fetch("/firmware/manifest.json", { cache: "no-store" });
    cached = r.ok ? ((await r.json()) as BundledFirmware) : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Compare "1.2.10" style versions: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Installed gateway version; null = firmware older than in-app updates (pre-1.2). */
export async function installedVersion(gw: GatewayTarget): Promise<string | null> {
  const h = await api.health(gw, 6000);
  return h.fw_version ?? null;
}

export function updateAvailable(installed: string | null, bundled: BundledFirmware | null): boolean {
  if (!bundled) return false;
  if (!installed) return true; // pre-1.2 firmware: always offer the update
  return compareVersions(bundled.version, installed) > 0;
}

/**
 * Upload the bundled firmware to the gateway. Uses XMLHttpRequest (not the
 * native HTTP bridge) for upload progress; the gateway allows this origin via
 * CORS on this one endpoint.
 */
export async function uploadFirmware(
  gw: GatewayTarget,
  fw: BundledFirmware,
  onProgress: (fraction: number) => void
): Promise<void> {
  const blob = await (await fetch(`/firmware/${fw.file}`, { cache: "no-store" })).blob();
  if (blob.size !== fw.size) throw new Error("Bundled firmware file is damaged — reinstall the app.");
  const form = new FormData();
  form.append("firmware", blob, fw.file);
  const host = gw.host.replace(/^https?:\/\//, "").replace(/\/+$/, "");

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `http://${host}/api/ota/upload`);
    xhr.setRequestHeader("Authorization", `Bearer ${gw.token}`);
    xhr.setRequestHeader("X-MD5", fw.md5);
    xhr.timeout = 180000;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `Update failed (${xhr.status}).`;
      try {
        msg = (JSON.parse(xhr.responseText) as { error?: string }).error ?? msg;
      } catch {
        /* keep generic */
      }
      reject(new Error(msg));
    };
    // The gateway restarts right after replying; a dropped connection at
    // 100 % usually means it already installed and rebooted.
    xhr.onerror = () => reject(new Error("upload-connection-lost"));
    xhr.ontimeout = () => reject(new Error("The gateway did not respond in time."));
    xhr.send(form);
  });
}

/** Wait for the gateway to come back on `version` (after it restarts). */
export async function waitForVersion(gw: GatewayTarget, version: string, timeoutMs = 120000): Promise<boolean> {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 6000)); // reboot + Wi-Fi join
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await installedVersion(gw);
      if (v && compareVersions(v, version) === 0) return true;
    } catch {
      /* still rebooting */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}
