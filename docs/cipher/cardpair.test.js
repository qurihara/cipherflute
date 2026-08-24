"use strict";
/* v3カード2枚（2-of-2）の通し検査。
 * 実物のカードと同じ音の並びから理想周波数を作り、1枚ずつ復号して足し合わせ、
 * 秘密260729が戻ることを確かめる。復号ページの「4. 2枚を合わせて認証する」が
 * 内部で行う手順と同じである。 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const codec = require("./cipher_codec.js");

const base = JSON.parse(fs.readFileSync(path.join(__dirname, "cipher_config.json"), "utf8"));
// カードは12スロット（G#6〜G7）・隣接同音禁止・パリティ1・記号モードで作ってある。
const cfg = Object.assign({}, base, {
  hi_note: "G7", no_repeat: true, ecc_parity: 1, mode: "symbols",
});

const CARD_A = ["C7", "C#7", "A#6", "B6", "E7", "G#6", "C#7", "D7"];
const CARD_B = ["C7", "C#7", "B6", "G#6", "D7", "G#6", "C7", "D#7"];
const SECRET = 260729;

function decodeCard(notes, label) {
  const freqs = notes.map(codec.noteToFreq);
  const r = codec.decode(freqs, cfg, true);
  assert(!r.status.startsWith("error:"), `${label}: ${r.status}`);
  assert.strictEqual(r.symbols.length, 6, `${label}: 記号は6個のはず`);
  return r.symbols;
}

const a = decodeCard(CARD_A, "カードA");
const b = decodeCard(CARD_B, "カードB");
assert.deepStrictEqual(a, [0, 8, 0, 4, 3, 4], "カードAの記号");
assert.deepStrictEqual(b, [0, 9, 8, 5, 5, 3], "カードBの記号");
console.log("PASS 1枚ずつの復号: A=[" + a.join(",") + "] B=[" + b.join(",") + "]");

const m = codec.slots(cfg).length;
const symBase = codec._wireParams(cfg, m).mb;
assert.strictEqual(symBase, 11, "12スロット・隣接同音禁止なら記号の底は11");

const got = codec.combineShares([a, b], symBase);
assert.strictEqual(got.value, SECRET, "2枚を合わせた秘密");
console.log("PASS 2枚を合わせる: " + got.value);

// 片方だけでは秘密にならない（どちらの断片も秘密と一致しない）
assert.notStrictEqual(Number(codec._fromBase(a, symBase)), SECRET);
assert.notStrictEqual(Number(codec._fromBase(b, symBase)), SECRET);
console.log("PASS 片方だけでは秘密にならない");

// 1本鳴らなかった場合。いまのカードはパリティ1なので、[* 直せるのは最後の1本だけ]である。
// 隣接同音禁止の差分符号化では、1本欠けると次の記号まで壊れて2記号ぶんの損失になり、
// パリティ1（1記号ぶん）では足りない。パリティ2にすればどの位置でも直せる（別途確認済み）。
{
  const dead = (notes, pos) => {
    const f = notes.map(codec.noteToFreq);
    f[pos] = codec.noteToFreq("G#6") / 2;      // 音域外＝消失として扱われる
    return codec.decode(f, cfg, true);
  };
  const last = dead(CARD_A, CARD_A.length - 1);
  assert(!last.status.startsWith("error:"), `最後の1本の消失: ${last.status}`);
  assert.deepStrictEqual(last.symbols, a, "最後の1本なら復元できる");
  console.log("PASS 最後の1本の消失は直せる（" + last.status + "）");

  const middle = dead(CARD_A, 4);
  const failed = middle.status.startsWith("error:") || JSON.stringify(middle.symbols) !== JSON.stringify(a);
  assert(failed, "途中の1本の消失はパリティ1では直せないはず");
  console.log("PASS 途中の1本の消失は直せない（" + middle.status + "）＝吹き直しが要る");
}

console.log("ALL PASS (2-of-2 カード)");
