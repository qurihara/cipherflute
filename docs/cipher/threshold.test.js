"use strict";
/* しきい値秘密分散（2-of-3）の検査。Python版 fue/threshold.py と同じ値になることを確かめる。
 * 実行: node docs/cipher/threshold.test.js
 */
const assert = require("assert");
const codec = require("./cipher_codec.js");

// 実物の3つの担体（箱・カード・本立て）。秘密は124816。
const SHARES = [
  {x: 1, symbols: [6, 7, 1, 2, 1]},   // 箱
  {x: 2, symbols: [4, 9, 5, 10, 3]},  // カード
  {x: 3, symbols: [2, 0, 9, 7, 5]},   // 本立て
];
const SECRET = 124816;
const BASE = 11;
let n = 0;
const ok = (m) => { n++; console.log("PASS " + m); };

// どの2つでも復元できる
for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
  const got = codec.combineThreshold([SHARES[a], SHARES[b]], BASE);
  assert.strictEqual(got.value, SECRET, `断片${a + 1}+${b + 1}`);
}
ok("どの2つでも秘密が戻る（1+2, 1+3, 2+3）");

// 3つ全部でも同じ
assert.strictEqual(codec.combineThreshold(SHARES, BASE).value, SECRET);
ok("3つ全部でも同じ秘密");

// 1つだけでは復元できない（そもそも受け付けない）
assert.throws(() => codec.combineThreshold([SHARES[0]], BASE), /2つ以上/);
ok("断片1つは受け付けない");

// 番号を間違えると別の値になる（番号が鍵の一部であることの確認）
{
  const wrong = codec.combineThreshold(
    [{x: 1, symbols: SHARES[1].symbols}, {x: 2, symbols: SHARES[2].symbols}], BASE);
  assert.notStrictEqual(wrong.value, SECRET);
  ok("番号を取り違えると別の値になる（" + wrong.value + "）");
}

// 受け付けない入力
assert.throws(() => codec.combineThreshold([{x: 1, symbols: [1]}, {x: 1, symbols: [2]}], BASE), /同じ番号/);
assert.throws(() => codec.combineThreshold([{x: 1, symbols: [1, 2]}, {x: 2, symbols: [3]}], BASE), /記号数/);
assert.throws(() => codec.combineThreshold([{x: 0, symbols: [1]}, {x: 2, symbols: [3]}], BASE), /番号は1から/);
assert.throws(() => codec.combineThreshold([{x: 1, symbols: [11]}, {x: 2, symbols: [3]}], BASE), /範囲外/);
ok("不正な入力を弾く");

// 2-of-2（足して秘密）とは別の計算であることを確認
{
  const sum = codec.combineShares([SHARES[0].symbols, SHARES[1].symbols], BASE);
  assert.notStrictEqual(sum.value, SECRET);
  ok("2-of-2の足し算とは別の計算（混同すると開かない）");
}

console.log(`ALL PASS (${n}件)`);
