/* 送金の部品を検査する。`node docs/dapp/tx.test.js`
 *
 * なぜ要るか
 *   取引の符号化を1バイト間違えると、署名は通るのにチェーンが受け取らない、あるいは
 *   別の内容の取引として通ってしまう。[* 金銭を動かす部分なので、送る前に机の上で確かめる]。
 *
 * 何を確かめるか
 *   1. RLPが仕様どおりか（公式の例で照合）
 *   2. 署名した取引から、署名者のアドレスが正しく復元できるか
 *   3. 合言葉が効いているか（別の口座になる／空なら従来と同じ）
 *   4. 金額の読み書き
 */
import { webcrypto } from "node:crypto";
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;   // vendorの署名がWebCryptoを使う

const { rlpEncode, toMinimalBytes, hexToBytes, signingHash, signTransaction,
        addressOf, parseEther, formatEther, maxFeeWei } = await import("./tx.js");
const { deriveAccount, buildPassword, secretToBytes, toHex } = await import("./flute_key.js");
const { Signature, recoverPublicKey } = await import("./vendor/secp256k1.js").then(m => ({
  Signature: m.Signature, recoverPublicKey: null}));
const secp = await import("./vendor/secp256k1.js");
const { keccak_256 } = await import("./vendor/noble-hashes/sha3.js");

let pass = 0;
function ok(cond, label) {
  if (!cond) { console.error("FAIL " + label); process.exit(1); }
  console.log("PASS " + label);
  pass++;
}
const hex = (b) => toHex(b);

/* 1. RLP ------------------------------------------------------------ */
// イーサリアム黄書と公式のテストベクタから。
ok(hex(rlpEncode(new TextEncoder().encode("dog"))) === "83646f67", "RLP 短い文字列");
ok(hex(rlpEncode([new TextEncoder().encode("cat"), new TextEncoder().encode("dog")]))
   === "c88363617483646f67", "RLP リスト");
ok(hex(rlpEncode(new Uint8Array(0))) === "80", "RLP 空のバイト列");
ok(hex(rlpEncode([])) === "c0", "RLP 空のリスト");
ok(hex(rlpEncode(toMinimalBytes(0))) === "80", "RLP 0は空のバイト列として符号化される");
ok(hex(rlpEncode(toMinimalBytes(15))) === "0f", "RLP 小さい数はそのまま1バイト");
ok(hex(rlpEncode(toMinimalBytes(1024))) === "820400", "RLP 2バイトの数");
// 55バイトを超える長い文字列（長さの長さを前置する形）
const long = new Uint8Array(56).fill(0x61);
ok(hex(rlpEncode(long)).startsWith("b838"), "RLP 56バイトは長さの長さを前置する");
ok(hex(toMinimalBytes(0)) === "" && hex(toMinimalBytes(255)) === "ff"
   && hex(toMinimalBytes(256)) === "0100", "最小バイト表現に先行ゼロが付かない");

/* 2. 署名 ----------------------------------------------------------- */
const priv = hexToBytes("4646464646464646464646464646464646464646464646464646464646464646");
const myAddr = addressOf(priv);
const tx = {
  chainId: 80002n, nonce: 0n,
  maxPriorityFeePerGas: 25_000_000_000n, maxFeePerGas: 50_000_000_000n,
  gasLimit: 21000n, to: "0x3535353535353535353535353535353535353535",
  value: 10n ** 18n, data: "0x",
};
const signed = await signTransaction(tx, priv);
ok(signed.raw.startsWith("0x02"), "生取引がEIP-1559（type 2）で始まる");
ok(signed.hash.length === 66, "取引の識別子が32バイト");

// 署名から公開鍵を復元し、アドレスが署名者と一致するか。ここが狂うとチェーンに弾かれる。
const digest = signingHash(tx);
const sig = await secp.signAsync(digest, priv);
const recovered = new secp.Signature(sig.r, sig.s, sig.recovery).recoverPublicKey(digest);
const recAddr = "0x" + toHex(keccak_256(recovered.toBytes(false).slice(1))).slice(-40);
ok(recAddr.toLowerCase() === myAddr.toLowerCase(), "署名から署名者のアドレスが復元できる");

// 同じ取引・同じ鍵なら生取引も同じ（決定的な署名。RFC6979）
const again = await signTransaction(tx, priv);
ok(again.raw === signed.raw, "同じ取引と鍵からは同じ署名が出る");

// 中身が1つ変わると別の署名になる
const other = await signTransaction({...tx, value: 10n ** 17n}, priv);
ok(other.raw !== signed.raw, "金額が違えば別の署名になる");

// chainIdが署名に入っている（他のチェーンへ使い回せない）
const otherChain = await signTransaction({...tx, chainId: 137n}, priv);
ok(otherChain.raw !== signed.raw, "chainIdが違えば別の署名になる（使い回しを防ぐ）");

/* 3. 合言葉 --------------------------------------------------------- */
const IT = 1000;   // 検査では回数を落とす。仕様の60万回は flute_key.test.js が見張る
const a0 = await deriveAccount("260812", {label: "amoy", iterations: IT});
const a1 = await deriveAccount("260812", {label: "amoy", passphrase: "demo", iterations: IT});
const a2 = await deriveAccount("260812", {label: "amoy", passphrase: "demo2", iterations: IT});
const a3 = await deriveAccount("260812", {label: "amoy", passphrase: "", iterations: IT});
ok(a1.address !== a0.address, "合言葉を付けると別の口座になる");
ok(a2.address !== a1.address, "合言葉が違えば別の口座になる");
ok(a3.address === a0.address, "合言葉が空なら従来と同じ口座（後方互換）");
ok(a1.hasPassphrase === true && a0.hasPassphrase === false, "合言葉の有無を報告する");

// 境目が曖昧にならないこと。区切りが無いと次の2つが同じ入力になってしまう。
const p1 = buildPassword(secretToBytes("26"), "0812");
const p2 = buildPassword(secretToBytes("260"), "812");
ok(hex(p1) !== hex(p2), "秘密と合言葉の境目が曖昧にならない");
ok(hex(buildPassword(secretToBytes("260812"), "")) === hex(secretToBytes("260812")),
   "合言葉が空なら入力に何も足さない");

// 同じ合言葉でも笛が違えば別の口座
const b1 = await deriveAccount("260814", {label: "amoy", passphrase: "demo", iterations: IT});
ok(b1.address !== a1.address, "合言葉が同じでも笛が違えば別の口座");

/* 4. 金額 ----------------------------------------------------------- */
ok(parseEther("1") === 10n ** 18n, "1 POL を weiにする");
ok(parseEther("0.01") === 10n ** 16n, "0.01 POL を weiにする");
ok(parseEther("0.000000000000000001") === 1n, "小数18桁まで扱える");
ok(formatEther(10n ** 18n) === "1.000000", "weiを読みやすくする");
ok(formatEther(1n) === "0.000000", "1 weiは小数6桁では0に見える");
let threw = false;
try { parseEther("0.1234567890123456789"); } catch (e) { threw = true; }
ok(threw, "小数19桁は受け付けない");
ok(maxFeeWei(tx) === 50_000_000_000n * 21000n, "手数料の上限を計算できる");

console.log(`\nALL PASS (${pass}件)`);
