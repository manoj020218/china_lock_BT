/**
 * Sharing helpers: text (temporary codes) and files (Excel exports) via the
 * Android share sheet — WhatsApp, SMS, email, Drive… — with browser fallbacks.
 */

import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

import { toBase64 } from "./xlsx";

const NATIVE = Capacitor.isNativePlatform();

/** Open the system share sheet with a message (falls back to copying). */
export async function shareText(title: string, text: string): Promise<"shared" | "copied"> {
  if (NATIVE) {
    await Share.share({ title, text, dialogTitle: title });
    return "shared";
  }
  if (navigator.share) {
    await navigator.share({ title, text });
    return "shared";
  }
  await navigator.clipboard.writeText(text);
  return "copied";
}

/** Direct WhatsApp / SMS links (the app picks the contact). */
export const whatsappUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;
export const smsUrl = (text: string) => `sms:?body=${encodeURIComponent(text)}`;

/** Save a binary file and open the share sheet (or download in a browser). */
export async function shareFile(fileName: string, bytes: Uint8Array, mime: string, title: string): Promise<void> {
  if (NATIVE) {
    const res = await Filesystem.writeFile({
      path: fileName,
      data: toBase64(bytes),
      directory: Directory.Cache
    });
    await Share.share({ title, files: [res.uri], dialogTitle: title });
    return;
  }
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
