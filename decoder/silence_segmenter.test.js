"use strict";
/* 無音区切りの状態機械のテスト。合成したレベル列を流し込んで、狙いどおりに
 * 本数と周波数が取れるかを確かめる。実マイクは使わない。 */

const assert = require("assert");
const seg = require("./silence_segmenter.js");

const FRAME_MS = 16;   // 60フレーム毎秒を想定

/* 台本から毎フレームの (level, freq) を作る。
 * 台本は [{ms, db, hz}, ...] の並びで、各区間をその値で埋める。 */
function render(script) {
  const frames = [];
  let t = 0;
  script.forEach(part => {
    const n = Math.round(part.ms / FRAME_MS);
    for (let i = 0; i < n; i++) {
      frames.push({t: t, level: part.db, freq: part.hz || 0});
      t += FRAME_MS;
    }
  });
  return frames;
}

function run(script, options) {
  const s = seg.create(options);
  const notes = [];
  let ended = false;
  render(script).forEach(f => {
    const ev = s.feed(f.t, f.level, f.freq);
    if (ev.type === "note") notes.push(ev);
    if (ev.type === "end") ended = true;
  });
  return {notes: notes, ended: ended, thresholds: s.thresholds()};
}

const QUIET = {ms: 600, db: -95};          // 暗騒音（測定用に十分な長さ）
const note = (hz, ms) => ({ms: ms || 400, db: -45, hz: hz});
const gap = (ms) => ({ms: ms || 300, db: -95});

// 1) 基本：5本を無音で区切って吹く
{
  const r = run([QUIET, note(1046), gap(), note(1318), gap(), note(1567), gap(),
                 note(1975), gap(), note(2093), gap(3000)]);
  assert.strictEqual(r.notes.length, 5, "5本に切り分かれる");
  const hz = r.notes.map(n => Math.round(n.freq));
  assert.deepStrictEqual(hz, [1046, 1318, 1567, 1975, 2093], "各本の周波数が取れる");
  assert.ok(r.ended, "最後の長い無音で終わりを検出する");
  console.log("  1) 基本 5本:", hz.join(","), " しきい値", JSON.stringify(r.thresholds));
}

// 2) 速い演奏：音200ms・無音200msでも切り分かれる
{
  const r = run([QUIET, note(1046, 200), gap(200), note(1318, 200), gap(200),
                 note(1567, 200), gap(3000)]);
  assert.strictEqual(r.notes.length, 3, "短い音でも3本に切り分かれる");
  console.log("  2) 速い演奏(音200ms/無音200ms):", r.notes.map(n => Math.round(n.freq)).join(","));
}

// 3) 短すぎる雑音は捨てる（60msのパチッという音）
{
  const r = run([QUIET, {ms: 60, db: -45, hz: 1500}, gap(),
                 note(1046), gap(3000)]);
  assert.strictEqual(r.notes.length, 1, "雑音を除いて1本だけ");
  assert.strictEqual(Math.round(r.notes[0].freq), 1046);
  console.log("  3) 短い雑音を捨てる: 本数", r.notes.length);
}

// 4) 音の中の一瞬のふらつき（既定の gapMs=100 より短い 60ms）では切れない
{
  const r = run([QUIET, note(1046, 300), {ms: 60, db: -95}, note(1046, 300), gap(3000)]);
  assert.strictEqual(r.notes.length, 1, "gapMs未満のふらつきでは切れない");
  console.log("  4) 一瞬のふらつき(60ms)で切れない: 本数", r.notes.length);
}

// 4') 逆に、gapMs 以上の無音（150ms）ならきちんと切れる
{
  const r = run([QUIET, note(1046, 300), {ms: 150, db: -95}, note(1318, 300), gap(3000)]);
  assert.strictEqual(r.notes.length, 2, "gapMs以上の無音では切れる");
  console.log("  4') 150msの無音で切れる: 本数", r.notes.length);
}

// 5) うるさい部屋：暗騒音が高くても相対しきい値で動く
{
  const loudRoom = {ms: 600, db: -70};
  const r = run([loudRoom, {ms: 400, db: -40, hz: 1046}, {ms: 300, db: -70},
                 {ms: 400, db: -40, hz: 1318}, {ms: 3000, db: -70}]);
  assert.strictEqual(r.notes.length, 2, "暗騒音が高くても2本に切り分かれる");
  console.log("  5) うるさい部屋(暗騒音-70dB): 本数", r.notes.length,
              " しきい値", JSON.stringify(r.thresholds));
}

// 6) 立ち上がりの音程の揺れは測定から外れる（最初の50msだけ外れた値）
{
  const r = run([QUIET, {ms: 48, db: -45, hz: 800}, {ms: 400, db: -45, hz: 1046}, gap(3000)]);
  assert.strictEqual(r.notes.length, 1);
  assert.strictEqual(Math.round(r.notes[0].freq), 1046, "立ち上がりの揺れに引きずられない");
  console.log("  6) 立ち上がりの揺れを除く:", Math.round(r.notes[0].freq), "Hz");
}

// 7) 26本（スプール pass_#26 相当）を通しで切り分ける
{
  const script = [QUIET];
  const want = [];
  for (let i = 0; i < 26; i++) {
    const hz = 1400 + i * 40;
    want.push(hz);
    script.push(note(hz, 250));
    script.push(gap(250));
  }
  script.push(gap(3000));
  const r = run(script);
  assert.strictEqual(r.notes.length, 26, "26本すべて切り分かれる");
  assert.deepStrictEqual(r.notes.map(n => Math.round(n.freq)), want);
  const totalSec = (26 * 0.25 + 27 * 0.25 + 0.6).toFixed(1);
  console.log("  7) 26本の通し: 本数", r.notes.length, " 所要", totalSec, "秒");
}

// 8) 復号ページは endMs を無効化して使う（終わりは利用者がボタンで決める）
{
  const r = run([QUIET, note(1046), gap(), note(1318), gap(10000)],
                {endMs: Number.MAX_SAFE_INTEGER});
  assert.strictEqual(r.notes.length, 2, "2本は切り分かれる");
  assert.strictEqual(r.ended, false, "10秒放置しても自動終了しない");
  console.log("  8) 終了判定を無効化: 本数", r.notes.length, " 自動終了", r.ended);
}

// 9) 無音のまま何も吹かなければ、何も確定しない
{
  const r = run([QUIET, gap(3000)]);
  assert.strictEqual(r.notes.length, 0);
  assert.strictEqual(r.ended, false, "1本も無いなら終わり判定も出ない");
  console.log("  9) 無音のみ: 本数", r.notes.length, " 終了検出", r.ended);
}

// --- ここから、音の変わり目でも区切る方式（息を切らずに続けて吹く読み方）---
const SPLIT = {pitchSplitCents: 50, pitchStableMs: 70};
const cent = (hz, c) => hz * Math.pow(2, c / 1200);

// 10) 無音を一切置かず、音を変えるだけで切り分かれる
{
  const script = [QUIET];
  const want = [1046, 1318, 1567, 1975];
  want.forEach(hz => script.push({ms: 300, db: -45, hz: hz}));   // 続けて鳴らす
  script.push(gap(500));
  const r = run(script, SPLIT);
  assert.strictEqual(r.notes.length, 4, "無音なしでも4本に切り分かれる");
  assert.deepStrictEqual(r.notes.map(n => Math.round(n.freq)), want);
  console.log(" 10) 無音なしで音の変わり目のみ:", r.notes.map(n => Math.round(n.freq)).join(","));
}

// 11) 1本の中の音のふらつき（±25セント）では切れない
{
  const script = [QUIET];
  for (let i = 0; i < 12; i++) {
    script.push({ms: 40, db: -45, hz: cent(1046, i % 2 ? 25 : -25)});
  }
  script.push(gap(500));
  const r = run(script, SPLIT);
  assert.strictEqual(r.notes.length, 1, "しきい値未満のふらつきでは切れない");
  console.log(" 11) ±25セントのふらつきで切れない: 本数", r.notes.length);
}

// 12) 隣り合うスロット（100セント差）でもきちんと切れる
{
  const r = run([QUIET, {ms: 300, db: -45, hz: 1046},
                        {ms: 300, db: -45, hz: cent(1046, 100)}, gap(500)], SPLIT);
  assert.strictEqual(r.notes.length, 2, "100セント差でも切れる");
  const d = Math.round(1200 * Math.log2(r.notes[1].freq / r.notes[0].freq));
  assert.ok(Math.abs(d - 100) < 15, "測った音程差が100セント付近");
  console.log(" 12) 100セント差で切れる: 本数", r.notes.length, " 測った差", d, "セント");
}

// 13) 無音と音の変わり目が混ざっていても両方で切れる
{
  const r = run([QUIET, {ms: 300, db: -45, hz: 1046},
                        {ms: 300, db: -45, hz: 1318},   // 息を切らずに変える
                        gap(250),                        // ここは息を切る
                        {ms: 300, db: -45, hz: 1567},
                        gap(500)], SPLIT);
  assert.strictEqual(r.notes.length, 3, "無音でも変わり目でも切れる");
  console.log(" 13) 無音と変わり目の混在: 本数", r.notes.length);
}

// 14) 短すぎる音は、続けて吹いていても捨てる（滑らせた途中で一瞬鳴る音）
{
  const r = run([QUIET, {ms: 300, db: -45, hz: 1046},
                        {ms: 80,  db: -45, hz: 1200},   // 通りすがりの短い音
                        {ms: 300, db: -45, hz: 1567}, gap(500)], SPLIT);
  assert.strictEqual(r.notes.length, 2, "短すぎる音は捨てる");
  console.log(" 14) 通りすがりの短い音を捨てる: 本数", r.notes.length,
              " →", r.notes.map(n => Math.round(n.freq)).join(","));
}

// 15) 印刷済みスプール pass_#26 の実際の音列を、無音なしで通しで読む
{
  const HZ = {"G#6":1661.22,"A6":1760.00,"A#6":1864.66,"B6":1975.53,"C7":2093.00,
              "C#7":2217.46,"D7":2349.32,"D#7":2489.02,"E7":2637.02,"F7":2793.83,"F#7":2959.96};
  const seq = ["C7","A6","C#7","G#6","A#6","D7","A#6","E7","B6","C7","C#7","B6","A#6",
               "D#7","F#7","A#6","D7","A#6","A6","G#6","F7","A6","F7","E7","F7","C#7"];
  const script = [QUIET];
  seq.forEach(n => script.push({ms: 250, db: -45, hz: HZ[n]}));   // 息継ぎなし
  script.push(gap(500));
  const r = run(script, SPLIT);
  assert.strictEqual(r.notes.length, 26, "26本すべて切り分かれる");
  const got = r.notes.map(n => Math.round(n.freq));
  assert.deepStrictEqual(got, seq.map(n => Math.round(HZ[n])));
  console.log(" 15) スプール26本を無音なしで通し: 本数", r.notes.length,
              " 所要", (26 * 0.25 + 0.6).toFixed(1), "秒");
}

// 16) 暗騒音を外から与えると、冒頭の測定を待たずに1本目から拾える
//     （録音は冒頭が無音とは限らない。いきなり鳴っている録音でも取りこぼさないため）
{
  const script = [note(2093, 400), gap(300), note(2217, 400), gap(500)];  // 冒頭の静けさなし
  const withCalib = run(script, SPLIT);
  const given = run(script, Object.assign({}, SPLIT, {noiseDb: -95}));
  // 冒頭の400msがまるごと測定に使われ、鳴っている音を暗騒音とみなしてしまうので、
  // そのあとの音も「静かな側」と判定されて1本も拾えない
  assert.strictEqual(withCalib.notes.length, 0, "冒頭が鳴っていると1本も拾えない");
  assert.strictEqual(given.notes.length, 2, "外から与えれば1本目から拾える");
  assert.strictEqual(given.thresholds.noiseDb, -95);
  // 与えた暗騒音が静かすぎるときは下限（absOnDb）が効く。測定したときと同じ決め方である
  assert.strictEqual(given.thresholds.onDb, seg.DEFAULTS.absOnDb);
  const loud = run(script, Object.assign({}, SPLIT, {noiseDb: -60}));
  assert.strictEqual(loud.thresholds.onDb, -60 + seg.DEFAULTS.onMarginDb,
                     "下限より大きければ、暗騒音からの相対で決まる");
  console.log(" 16) 暗騒音を外から与える: 測定ありは", withCalib.notes.length,
              "本、与えると", given.notes.length, "本");
}

// 17) ★息を切らずに吹いた列でも、返す開始時刻はその音自身のもの★
//     以前は、音の変わり目で切ったときに「次の音の開始」を返していた。息を切らずに
//     吹いた列では全体がずれ、隣り合う音の間隔が0と出て、テンポの判定を狂わせた。
{
  const script = [QUIET];
  const hz = [2093, 2489, 2794];
  hz.forEach(h => script.push({ms: 400, db: -45, hz: h}));   // 息継ぎなし
  script.push(gap(500));
  const r = run(script, SPLIT);
  assert.strictEqual(r.notes.length, 3, "3本に切り分かれる");
  const t0 = r.notes[0].startMs;
  r.notes.forEach((n, i) => {
    // i本目は、静けさ600msのあと400msずつ進んだところから始まる
    assert.ok(Math.abs(n.startMs - (t0 + i * 400)) <= FRAME_MS,
              (i + 1) + "本目の開始が" + (t0 + i * 400) + "ms付近にない（" + n.startMs + "ms）");
  });
  const gaps = r.notes.slice(1).map((n, i) => n.startMs - r.notes[i].startMs);
  assert.ok(gaps.every(g => g > 300), "隣り合う開始の間隔が詰まっていない: " + gaps.join(","));
  console.log(" 17) 開始時刻はその音自身のもの: 間隔", gaps.join("・"), "ms");
}

console.log("silence_segmenter: 全17件パス");
