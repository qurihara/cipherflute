"use strict";
/* 「終了し復号」を押したときにコンソールへ書き出す測定値の形を確かめる。
 * 対象の関数は index.html のモジュール内にあるので、本文から切り出して評価する。
 * 出したものは Python 側の集計器 fue/calib_comb.py がそのまま読める形でなければ
 * ならない。その約束（コメント行の書き出し、1行12個、鳴らない笛は -）を固定する。 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

/* index.html から logMeasurements の定義だけを切り出す。 */
function extract(name) {
  const head = html.indexOf("function " + name + "(");
  assert.ok(head >= 0, name + " が index.html に見つからない");
  let i = html.indexOf("{", head), depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}") { depth--; if (depth === 0) return html.slice(head, j + 1); }
  }
  throw new Error(name + " の括弧が閉じていない");
}

/* 画面の要素は使わないので、つまみの値を返すだけの偽物を渡す。 */
const stubs = {
  pitchSplit: { checked: true },
  splitRange: { value: "40" },
  gapRange: { value: "220" },
};
const logMeasurements = new Function(
  "el", "console",
  extract("logMeasurements") + "; return logMeasurements;"
);

function run(seq, how) {
  let out = "";
  const fake = { log: (s) => { out += s; } };
  logMeasurements((id) => stubs[id], fake)(seq, how);
  return out;
}

function tone(hz) { return { freq: hz, note: null }; }
const SKIP = { freq: null, note: null, skipped: true };

/* 30本ぶん（両端が造形不良で4番から33番だけを吹いた場合を想定）。 */
function sample() {
  const seq = [];
  for (let i = 0; i < 30; i++) seq.push(tone(1976.0 + i * 37.25));
  seq[7] = SKIP;
  return seq;
}

(function test_header_is_a_comment_line() {
  const lines = run(sample(), "続けて吹く").split("\n");
  assert.ok(lines[0].startsWith("#"), "1行目はコメント行でなければならない: " + lines[0]);
  assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(lines[0]), "日時が入っていない: " + lines[0]);
  assert.ok(lines[0].includes("30本"), "本数が入っていない: " + lines[0]);
  assert.ok(lines[0].includes("うち鳴らず1本"), "鳴らなかった本数が入っていない: " + lines[0]);
  assert.ok(lines[0].includes("40セント/220ms"), "区切りの設定が入っていない: " + lines[0]);
  console.log("ok 見出しはコメント行で、日時と本数と区切りの設定が入る");
})();

(function test_twelve_values_per_line() {
  const lines = run(sample(), "続けて吹く").split("\n").slice(1);
  assert.strictEqual(lines.length, 3, "30本なら12個ずつ3行になるはず");
  assert.deepStrictEqual(lines.map(l => l.split(" ").length), [12, 12, 6]);
  console.log("ok 測定値は1行12個ずつ書き出される");
})();

(function test_skipped_keeps_its_place() {
  const vals = run(sample(), "続けて吹く").split("\n").slice(1).join(" ").split(" ");
  assert.strictEqual(vals[7], "-", "飛ばした笛は - で位置を保たなければならない");
  assert.strictEqual(vals[0], "1976.0", "周波数は小数第1位まで書く");
  assert.strictEqual(vals.filter(v => v === "-").length, 1);
  console.log("ok 鳴らなかった笛は - で位置が保たれる");
})();

(function test_other_modes_have_no_split_setting() {
  const head = run([tone(2093.0)], "1本ずつ入力").split("\n")[0];
  assert.ok(head.includes("1本ずつ入力"));
  assert.ok(!head.includes("区切り"), "続けて吹く以外では区切りの設定を書かない");
  console.log("ok 入力方式の名前が入り、関係のない設定は書かない");
})();

(function test_empty_sequence_writes_nothing() {
  assert.strictEqual(run([], "続けて吹く"), "");
  console.log("ok 1本もなければ何も書き出さない");
})();

console.log("全5件が通った");
