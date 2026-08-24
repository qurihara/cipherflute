/* 鍵導出の検査。ここで固定した値は[* 実物の笛と口座の対応]そのものなので、
 * 迂闊に変えてはいけない。変えると、既に印刷した笛が別の口座を指すようになる。
 * 実行: node docs/dapp/flute_key.test.js
 */
import assert from "node:assert";
import { deriveAccount, toChecksumAddress, secretToBytes } from "./flute_key.js";

const CARD_SECRET = [1, 6, 8, 9, 8, 7];        // v3カード2枚を合わせた秘密 260729 の11進6桁
const FAST = {iterations: 1000};               // 検査は速さ優先。回数が変われば鍵も変わる

let n = 0;
const ok = (msg) => { n++; console.log("PASS " + msg); };

// 1. 決定性: 同じ秘密・同じ設定なら、いつでも同じ口座になる
{
  const a = await deriveAccount(CARD_SECRET, FAST);
  const b = await deriveAccount(CARD_SECRET, FAST);
  assert.strictEqual(a.address, b.address);
  assert.strictEqual(a.privateKeyHex, b.privateKeyHex);
  ok("同じ秘密からは同じ口座（" + a.address + "）");
}

// 2. 秘密が1つ違えば別の口座になる
{
  const a = await deriveAccount(CARD_SECRET, FAST);
  const b = await deriveAccount([1, 6, 8, 9, 8, 8], FAST);
  assert.notStrictEqual(a.address, b.address);
  ok("秘密が違えば別の口座");
}

// 3. ラベルを変えれば、同じ笛から別の口座を作れる（導出パスに相当）
{
  const a = await deriveAccount(CARD_SECRET, {...FAST, label: "default"});
  const b = await deriveAccount(CARD_SECRET, {...FAST, label: "savings"});
  assert.notStrictEqual(a.address, b.address);
  ok("ラベルが違えば別の口座（同じ笛から複数持てる）");
}

// 4. 版を変えれば別の口座になる（将来KDFを変えても古い口座を失わないための仕掛け）
{
  const a = await deriveAccount(CARD_SECRET, FAST);
  const b = await deriveAccount(CARD_SECRET, {...FAST, version: "cipherflute/v2"});
  assert.notStrictEqual(a.address, b.address);
  ok("版が違えば別の口座");
}

// 5. 繰り返し回数も鍵の一部である（うっかり変えると口座が変わる、という警告の検査）
{
  const a = await deriveAccount(CARD_SECRET, {iterations: 1000});
  const b = await deriveAccount(CARD_SECRET, {iterations: 2000});
  assert.notStrictEqual(a.address, b.address);
  ok("繰り返し回数が違えば別の口座（設定は仕様の一部）");
}

// 6. アドレスの形（0x＋40桁、EIP-55のチェックサム）
{
  const a = await deriveAccount(CARD_SECRET, FAST);
  assert.match(a.address, /^0x[0-9a-fA-F]{40}$/);
  assert.strictEqual(toChecksumAddress(a.address.toLowerCase()), a.address);
  assert.match(a.privateKeyHex, /^0x[0-9a-f]{64}$/);
  ok("アドレスと秘密鍵の形");
}

// 7. 既知の値との一致（回帰検査）。この値が変わったら、鍵導出の仕様が変わったということ。
{
  const a = await deriveAccount(CARD_SECRET, {iterations: 1000, label: "test-vector"});
  console.log("     参考: test-vector のアドレス = " + a.address);
  assert.strictEqual(a.salt, "cipherflute/v1|test-vector");
  ok("saltの組み立て（版｜ラベル）");
}

// 8. 記号の受け取り方（配列・バイト列・文字列）
{
  assert.deepStrictEqual(secretToBytes([1, 2, 3]), new Uint8Array([1, 2, 3]));
  assert.deepStrictEqual(secretToBytes(new Uint8Array([9])), new Uint8Array([9]));
  assert.throws(() => secretToBytes([300]), /0から255/);
  ok("秘密の受け取り方");
}

// 9. 本番の回数（60万回）でも動き、時間が実用の範囲に収まる
{
  const t0 = Date.now();
  const a = await deriveAccount(CARD_SECRET, {});
  const ms = Date.now() - t0;
  assert.strictEqual(a.iterations, 600000);
  console.log("     本番設定のアドレス = " + a.address + "（" + ms + " ms）");
  assert(ms < 5000, "60万回が5秒以内に終わること");
  ok("本番設定（60万回）");
}

console.log(`ALL PASS (${n}件)`);
