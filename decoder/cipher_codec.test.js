"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const codec = require("./cipher_codec.js");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "cipher_config.json"), "utf8"));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "cipher_test_vectors.json"), "utf8"));

// ベクタごとの config は既定(cipher_config.json)への上書き。11スロット等の後方互換検査に使う。
function cfgFor(vector) {
  return Object.assign({}, config, vector.config || {},
    {ecc_parity: vector.parity, mode: vector.mode, no_repeat: !!vector.no_repeat});
}

fixture.vectors.forEach((vector, index) => {
  const cfg = cfgFor(vector);
  const result = codec.decode(vector.measured_freqs, cfg);
  assert(!result.status.startsWith("error:"), `vector ${index}: ${result.status}`);
  let label;
  if (vector.mode === "symbols") {
    assert.deepStrictEqual(result.symbols, vector.expected_symbols, `vector ${index}`);
    label = "symbols [" + vector.symbols.join(",") + "]";
  } else {
    assert.strictEqual(codec.bytesToHex(result.payload), vector.expected_payload_hex, `vector ${index}`);
    label = vector.payload_hex;
  }
  console.log(`PASS ${index + 1}/${fixture.vectors.length}: ${label} parity=${vector.parity}` +
    `${vector.no_repeat ? " no_repeat" : ""}` +
    `${vector.config ? " " + JSON.stringify(vector.config) : ""} (${result.status})`);
});

// no_repeatのベクタでは、基準笛を含めて隣り合う笛が同じスロットにならない。
fixture.vectors.filter(v => v.no_repeat).forEach((vector, index) => {
  const cfg = cfgFor(vector);
  const table = codec.slots(cfg);
  const result = codec.decode(vector.measured_freqs, cfg);
  const seq = [((table.reference_index % table.length) + table.length) % table.length]
    .concat(result.decisions.map(d => d.slotIndex));
  assert(seq.every((s, i) => i === 0 || s !== seq[i - 1]), `no_repeat ${index}: 同じ音が隣り合った`);
  console.log(`PASS no_repeat adjacency ${index + 1} (${seq.length} slots)`);
});

// データ記号数が不正な笛列(RS的には無矛盾のd=1)はエラーになることを確認する。
{
  // 差分の写像を使わない作り（no_repeat: false）を前提にした検査なので、既定に頼らず明示する。
  const cfg = Object.assign({}, config, {ecc_parity: 2, mode: "sequential", no_repeat: false});
  const table = codec.slots(cfg);
  const {wb, p, w} = codec._wireParams(cfg, table.length);
  const wire = codec._rsEncode([5], 2, p);
  // RS記号1個は笛w本。スロット数mが素数でないとw>1になるので、必ずw本へ展開する。
  const digits = wire.reduce((out, s) => out.concat(codec._toBase(s, wb, w)), []);
  const freqs = [table[table.reference_index].freq_hz].concat(digits.map(s => table[s].freq_hz));
  const result = codec.decode(freqs, cfg);
  assert(result.status.includes("データ記号数が不正"), `bad-width: ${result.status}`);
  console.log("PASS bad-width rejection (" + result.status + ")");
}

// 2-of-2 の断片を合わせる計算。実物のv3カード2枚（秘密260729）と同じ値で確かめる。
{
  const a = [0, 8, 0, 4, 3, 4];
  const b = [0, 9, 8, 5, 5, 3];
  const got = codec.combineShares([a, b], 11);
  assert.strictEqual(got.value, 260729, "combineShares value");
  assert.deepStrictEqual(got.digits, codec._toBase(260729, 11, 6), "combineShares digits");
  // 片方だけでは秘密にならない（乱数のまま）ことも確かめる
  assert.notStrictEqual(codec._fromBase(a, 11), 260729);
  // 桁あふれは剰余で戻る
  assert.strictEqual(codec.combineShares([[10,10,10,10,10,10],[0,0,0,0,0,1]], 11).value, 0);
  // 記号数が違う断片は受け付けない
  assert.throws(() => codec.combineShares([[1,2],[1,2,3]], 11), /記号数/);
  console.log("PASS combineShares (2-of-2)");
}

console.log(`ALL PASS (${fixture.vectors.length} vectors)`);
