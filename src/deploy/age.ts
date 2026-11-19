// An age X25519 key pair (https://age-encryption.org/v1): the recipient is the Bech32 encoding of the public key
// under "age", the identity that of the private key under "AGE-SECRET-KEY-", in upper case.
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";

const ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]) {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = (check & 0x1ffffff) << 5 ^ value;
    [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3].forEach((generator, bit) => { if (top >>> bit & 1) check ^= generator; });
  }
  return check;
}
/** Bech32 (BIP 173) of `bytes` under the lower-case prefix `prefix`. */
function bech32(prefix: string, bytes: Uint8Array) {
  const data: number[] = [];
  let buffer = 0, bits = 0;
  for (const byte of bytes) {
    buffer = buffer << 8 | byte; bits += 8;
    while (bits >= 5) { bits -= 5; data.push(buffer >>> bits & 31); }
  }
  if (bits) data.push(buffer << 5 - bits & 31);
  const expanded = [...prefix].map((c) => c.charCodeAt(0) >>> 5).concat(0, [...prefix].map((c) => c.charCodeAt(0) & 31));
  const check = polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((index) => check >>> 5 * (5 - index) & 31);
  return prefix + "1" + [...data, ...checksum].map((value) => ALPHABET[value]).join("");
}

/** The pair for a 32-byte X25519 private key. */
export function ageKeyPair(privateKey: Uint8Array) {
  // PKCS #8 of an X25519 private key (RFC 8410): a fixed header, then the 32 bytes.
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), privateKey]), format: "der", type: "pkcs8" });
  const publicKey = Buffer.from(createPublicKey(key).export({ format: "jwk" }).x!, "base64url");
  return { recipient: bech32("age", publicKey), identity: bech32("age-secret-key-", privateKey).toUpperCase() };
}
export function generateAgeKeyPair() {
  return ageKeyPair(Buffer.from(generateKeyPairSync("x25519").privateKey.export({ format: "jwk" }).d!, "base64url"));
}
