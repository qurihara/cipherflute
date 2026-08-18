/* 笛から導いた鍵で、イーサリアム互換の取引に署名して送る。
 *
 * 何をするか
 *   EIP-1559（type 2）の取引を組み立て、RLPで符号化し、keccak256でハッシュし、
 *   secp256k1で署名して、`eth_sendRawTransaction` で送れる生の取引を返す。
 *
 * 設計の要点
 *   * [自分で署名する] 財布アプリを介さない。笛を吹くと鍵が現れ、その鍵が直接署名する。
 *     「笛が財布そのもの」という筋を保つためである。
 *   * [何に署名するのかを呼び出し側へ返す] 金額・宛先・手数料の上限を人が読める形で
 *     画面に出せるよう、組み立てた内容をそのまま返す。黙って署名しない。
 *   * [chainIdを署名に含める] EIP-1559の取引はchainIdが署名対象に入るので、
 *     別のチェーンへ同じ署名を使い回せない。
 *
 * 外部ライブラリは vendor/ に置いたものだけを使う。
 */
import { keccak_256 } from "./vendor/noble-hashes/sha3.js?v=2";
import { signAsync, getPublicKey } from "./vendor/secp256k1.js?v=2";
import { toHex, toChecksumAddress } from "./flute_key.js?v=2";

/* ---------------------------------------------------------------- RLP */

/** 数を最小のバイト列にする。先行のゼロは付けない。0は空のバイト列。 */
export function toMinimalBytes(value) {
  let v = BigInt(value);
  if (v < 0n) throw new Error("負の数は符号化できない");
  if (v === 0n) return new Uint8Array(0);
  const out = [];
  while (v > 0n) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
  return Uint8Array.from(out);
}

function lengthPrefix(len, offset) {
  if (len <= 55) return Uint8Array.from([offset + len]);
  const lenBytes = toMinimalBytes(len);
  return Uint8Array.from([offset + 55 + lenBytes.length, ...lenBytes]);
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
}

/** RLPで符号化する。入力はバイト列か、その入れ子の配列。 */
export function rlpEncode(item) {
  if (Array.isArray(item)) {
    const body = concat(...item.map(rlpEncode));
    return concat(lengthPrefix(body.length, 0xc0), body);
  }
  const bytes = item;
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return concat(lengthPrefix(bytes.length, 0x80), bytes);
}

/** 0x付きの16進文字列をバイト列にする。奇数桁は先頭に0を足す。 */
export function hexToBytes(hex) {
  let h = String(hex).replace(/^0x/i, "");
  if (h.length % 2) h = "0" + h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/* ---------------------------------------------------------------- 取引 */

/** 取引の項目を、RLPに渡せる形（バイト列の配列）に整える。 */
function txFields(tx) {
  return [
    toMinimalBytes(tx.chainId),
    toMinimalBytes(tx.nonce),
    toMinimalBytes(tx.maxPriorityFeePerGas),
    toMinimalBytes(tx.maxFeePerGas),
    toMinimalBytes(tx.gasLimit),
    hexToBytes(tx.to),
    toMinimalBytes(tx.value),
    tx.data ? hexToBytes(tx.data) : new Uint8Array(0),
    [],                       // accessList。使わない
  ];
}

/** 署名の対象になるハッシュ（0x02 ‖ RLP(9項目) の keccak256）。 */
export function signingHash(tx) {
  const payload = concat(Uint8Array.from([0x02]), rlpEncode(txFields(tx)));
  return keccak_256(payload);
}

/**
 * 取引に署名して、送れる生の取引を返す。
 * @returns {raw, hash} raw は 0x付きの生取引、hash は取引の識別子
 */
export async function signTransaction(tx, privateKey) {
  const digest = signingHash(tx);
  const sig = await signAsync(digest, privateKey);
  const signed = [
    ...txFields(tx),
    toMinimalBytes(sig.recovery),          // yParity
    toMinimalBytes(sig.r),
    toMinimalBytes(sig.s),
  ];
  const raw = concat(Uint8Array.from([0x02]), rlpEncode(signed));
  return {raw: "0x" + toHex(raw), hash: "0x" + toHex(keccak_256(raw))};
}

/** 秘密鍵からアドレスを出す（署名の宛先が合っているかの確認用）。 */
export function addressOf(privateKey) {
  const pub = getPublicKey(privateKey, false);
  return toChecksumAddress("0x" + toHex(keccak_256(pub.slice(1))).slice(-40));
}

/* ---------------------------------------------------------------- 手数料と送信 */

/**
 * いまの手数料の相場から、取引の中身を組み立てる。
 * @param rpc  (method, params) => Promise<result> の関数
 */
export async function buildTransfer(rpc, {from, to, valueWei, chainId}) {
  const [nonceHex, block] = await Promise.all([
    rpc("eth_getTransactionCount", [from, "pending"]),
    rpc("eth_getBlockByNumber", ["latest", false]),
  ]);
  const baseFee = BigInt(block.baseFeePerGas ?? "0x0");

  // 優先手数料は、ノードが答えられればその値を使う。答えられなければ 30 gwei を置く。
  let priority = 30_000_000_000n;
  try {
    const p = await rpc("eth_maxPriorityFeePerGas", []);
    if (p) priority = BigInt(p);
  } catch (e) { /* 対応していないノードがある。既定のままでよい */ }
  if (priority < 25_000_000_000n) priority = 25_000_000_000n;   // Amoyは最低25 gwei前後を要求する

  // 上限は、基準手数料が2倍に上がっても通るように取る。使われなかった分は返る。
  const maxFee = baseFee * 2n + priority;

  let gasLimit = 21000n;
  try {
    const g = await rpc("eth_estimateGas", [{from, to, value: "0x" + valueWei.toString(16)}]);
    gasLimit = BigInt(g);
  } catch (e) { /* 単純な送金なら21000で足りる */ }

  return {
    chainId, nonce: BigInt(nonceHex), to, value: valueWei,
    maxPriorityFeePerGas: priority, maxFeePerGas: maxFee, gasLimit, data: "0x",
  };
}

/** 手数料の上限（wei）。残高がこれ＋送金額を上回っていないと通らない。 */
export function maxFeeWei(tx) {
  return tx.maxFeePerGas * tx.gasLimit;
}

/** 生の取引を送る。戻りは取引の識別子。 */
export async function sendRaw(rpc, raw) {
  return rpc("eth_sendRawTransaction", [raw]);
}

/** weiを読みやすい文字列にする（小数6桁まで）。 */
export function formatEther(wei) {
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
  return `${whole}.${frac}`;
}

/** 「0.01」のような文字列をweiにする。小数18桁まで。 */
export function parseEther(text) {
  const s = String(text).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error("金額の書き方が違います");
  const [w, f = ""] = s.split(".");
  if (f.length > 18) throw new Error("小数は18桁までです");
  return BigInt(w || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
}
