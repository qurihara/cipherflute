/* 笛から復号した秘密を、イーサリアム互換の口座（秘密鍵とアドレス）へ変換する。
 *
 * 設計の要点
 *   * [遅い鍵導出を必ず通す] 笛の秘密はエントロピーが小さいので、素のハッシュだと
 *     総当たりが一瞬で終わる。PBKDF2で1候補あたりの費用を上げる。ただしこれは費用を
 *     上げるだけで、足りないエントロピーを補うものではない（カード20.8bitは守れない）。
 *   * [決定性] 同じ笛からは必ず同じ口座が出る。だから笛を吹き直せばいつでも戻れる。
 *   * [saltに版と用途を入れる] 将来KDFを変えても古い笛の口座を失わないよう版を持つ。
 *     用途（ラベル）を変えれば、同じ笛から別々の口座を作れる。saltは公開してよい。
 *   * [鍵はメモリだけに置く] 保存はしない。ページを閉じれば消える。
 *
 * ブラウザ（WebCrypto）とNode（node:crypto の webcrypto）の両方で動く。
 */
import { keccak_256 } from "./vendor/noble-hashes/sha3.js?v=2";
import { getPublicKey, CURVE } from "./vendor/secp256k1.js?v=2";

export const KDF_VERSION = "cipherflute/v1";
export const DEFAULT_ITERATIONS = 600000;      // OWASPの推奨値（PBKDF2-HMAC-SHA256）

async function subtle() {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) return globalThis.crypto.subtle;
  const nodeCrypto = await import("node:crypto");
  return nodeCrypto.webcrypto.subtle;
}

/** 秘密（記号列またはバイト列）を32バイトへ正規化する。 */
export function secretToBytes(secret) {
  if (secret instanceof Uint8Array) return secret;
  if (Array.isArray(secret)) {
    if (secret.some(s => !Number.isInteger(s) || s < 0 || s > 255)) {
      throw new Error("記号は0から255の整数で渡す");
    }
    return Uint8Array.from(secret);
  }
  if (typeof secret === "string") return new TextEncoder().encode(secret);
  throw new Error("秘密は記号の配列・バイト列・文字列のいずれかで渡す");
}

export function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/** 秘密と合言葉をつないで、鍵導出への入力を作る。
 *
 * 合言葉は[* 秘密の側に混ぜる]（saltではなく）。saltは公開してよいものとして扱っており、
 * 合言葉は秘密の一部だからである。笛と合言葉の両方がそろわないと同じ鍵にならない。
 *
 * 区切りに 0x1f を入れるのは、境目を曖昧にしないためである。区切りが無いと
 * 秘密"26"＋合言葉"0812" と 秘密"260"＋合言葉"812" が同じ入力になってしまう。
 *
 * 合言葉が空のときは何も足さない。[* これまでに作った口座を変えないため]である。
 */
export function buildPassword(secretBytes, passphrase) {
  if (!passphrase) return secretBytes;
  const p = new TextEncoder().encode(passphrase);
  const out = new Uint8Array(secretBytes.length + 1 + p.length);
  out.set(secretBytes, 0);
  out[secretBytes.length] = 0x1f;
  out.set(p, secretBytes.length + 1);
  return out;
}

/** 32バイトの種を秘密鍵として使えるか確かめる。曲線の位数の外なら使えない。 */
function isValidPrivateKey(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v > 0n && v < CURVE.n;
}

/** EIP-55 のチェックサム付きアドレスにする（大文字小文字で誤記を検出できる形）。 */
export function toChecksumAddress(addrLower) {
  const body = addrLower.replace(/^0x/, "");
  const hash = toHex(keccak_256(new TextEncoder().encode(body)));
  let out = "0x";
  for (let i = 0; i < body.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
  }
  return out;
}

/**
 * 笛の秘密から口座を作る。
 * @param secret 記号の配列（例 [1,6,8,9,8,7]）またはバイト列
 * @param opts.label 用途のラベル。同じ笛から別の口座を作りたいときに変える
 * @param opts.passphrase 合言葉。笛と合わせて2要素にする。空なら笛だけで決まる
 * @param opts.iterations PBKDF2の繰り返し回数
 * @returns {privateKey, privateKeyHex, address, salt, iterations, version, hasPassphrase}
 */
export async function deriveAccount(secret, opts = {}) {
  const label = opts.label ?? "default";
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const version = opts.version ?? KDF_VERSION;
  const passphrase = opts.passphrase ?? "";
  const bytes = buildPassword(secretToBytes(secret), passphrase);
  const salt = `${version}|${label}`;
  const s = await subtle();

  // 種が曲線の外に出た場合に備えて、saltへ通し番号を足しながら作り直す（起きる確率は極小）。
  for (let counter = 0; counter < 256; counter++) {
    const saltFull = counter === 0 ? salt : `${salt}|${counter}`;
    const km = await s.importKey("raw", bytes, "PBKDF2", false, ["deriveBits"]);
    const bits = await s.deriveBits(
      {name: "PBKDF2", salt: new TextEncoder().encode(saltFull), iterations, hash: "SHA-256"},
      km, 256);
    const priv = new Uint8Array(bits);
    if (!isValidPrivateKey(priv)) continue;
    const pub = getPublicKey(priv, false);            // 65バイト（先頭0x04）
    const addr = "0x" + toHex(keccak_256(pub.slice(1))).slice(-40);
    return {
      privateKey: priv,
      privateKeyHex: "0x" + toHex(priv),
      address: toChecksumAddress(addr),
      salt: saltFull,
      iterations,
      version,
      hasPassphrase: passphrase !== "",
    };
  }
  throw new Error("秘密鍵を作れなかった（起こらないはずの事態）");
}
