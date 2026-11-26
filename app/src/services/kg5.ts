/**
 * Temporary 5-minute unlock code ("KG5"), computed on the phone exactly like
 * the vendor app's legacy Temporary password screen (utils/des.js
 * KG5_GetTmpPasswd). No BLE traffic: the lock derives the same code from its
 * own clock, so the lock time must be correct (the gateway keeps it synced).
 *
 *   block = "yyMMddHH" + minuteTens + (minuteUnits rounded down to 0|5) + "000000"
 *           (16 hex digits = 8 bytes)
 *   key   = admin string, space-padded / truncated to 8 ASCII chars
 *   out   = DES-ECB(key, block); code = ((out[5]&0x0F)<<16 | out[6]<<8 | out[7]) % 1e6
 */

// Standard DES tables (FIPS 46-3).
const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
const SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
const FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
const E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1];
const P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
const S = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11]
];

const toBits = (bytes: number[]): number[] => {
  const out: number[] = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) out.push((b >> i) & 1);
  return out;
};
const fromBits = (bits: number[]): number[] => {
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  return out;
};
const permute = (bits: number[], table: number[]) => table.map((p) => bits[p - 1]);

/** Single-block DES encryption (ECB), 8-byte key and block. */
export function desEncryptBlock(key: number[], block: number[]): number[] {
  const k = permute(toBits(key), PC1);
  let c = k.slice(0, 28);
  let d = k.slice(28);
  const subkeys: number[][] = [];
  for (const s of SHIFTS) {
    c = c.slice(s).concat(c.slice(0, s));
    d = d.slice(s).concat(d.slice(0, s));
    subkeys.push(permute(c.concat(d), PC2));
  }
  const ip = permute(toBits(block), IP);
  let l = ip.slice(0, 32);
  let r = ip.slice(32);
  for (let round = 0; round < 16; round++) {
    const x = permute(r, E).map((b, i) => b ^ subkeys[round][i]);
    const f: number[] = [];
    for (let i = 0; i < 8; i++) {
      const six = x.slice(i * 6, i * 6 + 6);
      const row = (six[0] << 1) | six[5];
      const col = (six[1] << 3) | (six[2] << 2) | (six[3] << 1) | six[4];
      const v = S[i][row * 16 + col];
      f.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
    }
    const fp = permute(f, P);
    const nr = l.map((b, i) => b ^ fp[i]);
    l = r;
    r = nr;
  }
  return fromBits(permute(r.concat(l), FP));
}

const hexBytes = (hex: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
};

/** The 5-minute slot containing `lockLocal` (a Date whose UTC fields are the lock's local time). */
export function kg5Slot(lockLocal: Date): { start: Date; end: Date } {
  const start = new Date(lockLocal.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() - (start.getUTCMinutes() % 5));
  return { start, end: new Date(start.getTime() + 5 * 60000) };
}

/**
 * Six-digit temporary code. `lockLocal` carries the lock's local wall-clock
 * time in its UTC fields (see lockLocalNow).
 */
export function kg5Code(admin: string, lockLocal: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  const t =
    p2(lockLocal.getUTCFullYear() % 100) +
    p2(lockLocal.getUTCMonth() + 1) +
    p2(lockLocal.getUTCDate()) +
    p2(lockLocal.getUTCHours()) +
    p2(lockLocal.getUTCMinutes()); // yyMMddHHmm
  const block = t.slice(0, 9) + String(5 * Math.floor(Number(t[9]) / 5)) + "000000";
  const keyStr = (admin + "        ").slice(0, 8);
  const key = Array.from(keyStr).map((ch) => ch.charCodeAt(0) & 0xff);
  const out = desEncryptBlock(key, hexBytes(block));
  const n = (((out[5] & 0x0f) << 16) | (out[6] << 8) | out[7]) % 1_000_000;
  return String(n).padStart(6, "0");
}

/**
 * Now, as the lock's local wall-clock time (tz = minutes east of UTC).
 * `skewMs` corrects for a wrong phone clock: it is (lock clock - phone clock),
 * measured once from the lock (see lockClockSkew).
 */
export function lockLocalNow(tzMinutes: number, skewMs = 0): Date {
  return new Date(Date.now() + tzMinutes * 60000 + skewMs);
}

/**
 * The lock validates codes against ITS clock, so measure how far the phone's
 * clock is off from it. `lockTime` is the lock's "YYYY-MM-DD HH:MM:SS".
 */
export function lockClockSkew(lockTime: string, tzMinutes: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(lockTime.trim());
  if (!m) return null;
  const lock = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return lock - (Date.now() + tzMinutes * 60000);
}
