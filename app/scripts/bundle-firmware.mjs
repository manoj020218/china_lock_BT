/**
 * Bundle the latest gateway firmware into the app (runs before every build).
 *
 * Copies firmware/.pio/build/esp32-s3/firmware.bin to
 * public/firmware/jenix-gateway.bin and writes public/firmware/manifest.json
 * with the version (from firmware/src/version.h), size, MD5 and SHA-256.
 * Every APK / Play Store release therefore ships the matching gateway build,
 * and users update the gateway from Gateway settings with one tap.
 *
 * Release checklist: bump FW_VERSION in firmware/src/version.h, build the
 * firmware (pio run), then build the app.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const fw = join(app, "..", "firmware");
const bin = join(fw, ".pio", "build", "esp32-s3", "firmware.bin");
const versionH = join(fw, "src", "version.h");
const outDir = join(app, "public", "firmware");

const strict = process.argv.includes("--strict");

if (!existsSync(bin) || !existsSync(versionH)) {
  const msg = "bundle-firmware: no firmware build found (run `pio run` in firmware/)";
  if (strict) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(`${msg} — keeping the previously bundled firmware, if any.`);
  process.exit(0);
}

const version = /#define\s+FW_VERSION\s+"([^"]+)"/.exec(readFileSync(versionH, "utf8"))?.[1];
if (!version) {
  console.error("bundle-firmware: FW_VERSION not found in firmware/src/version.h");
  process.exit(1);
}

const data = readFileSync(bin);
if (data[0] !== 0xe9) {
  console.error("bundle-firmware: firmware.bin is not an ESP32 image (bad magic byte)");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "jenix-gateway.bin"), data);
const manifest = {
  version,
  size: data.length,
  md5: createHash("md5").update(data).digest("hex"),
  sha256: createHash("sha256").update(data).digest("hex"),
  built: statSync(bin).mtime.toISOString(),
  file: "jenix-gateway.bin"
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`bundle-firmware: gateway firmware v${version} (${(data.length / 1024).toFixed(0)} KB) bundled`);
