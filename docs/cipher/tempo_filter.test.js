/* tempo_filter の検査。node docs/cipher/tempo_filter.test.js で走る。 */
const TF = require("./tempo_filter.js");

let ok = 0, ng = 0;
function check(label, cond, extra) {
  if (cond) { ok++; console.log("  ok   " + label); }
  else { ng++; console.log("  NG   " + label + (extra ? "  → " + extra : "")); }
}

/* 900ms間隔で8本、きれいに吹いた列を作る。 */
function cleanRun(n, beat) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({kind: "note", freq: 2000 + i * 50, durationMs: beat * 0.6, startMs: i * beat});
  }
  return out;
}

console.log("■ きれいに吹いた列は、そのまま全部残る");
{
  const r = TF.analyze(cleanRun(8, 900), {});
  check("テンポを900msと測れる", r.beatMs === 900, "beatMs=" + r.beatMs);
  check("8本すべて残る", r.items.filter(i => i.keep).length === 8);
}

console.log("■ 拍から外れた短い雑音は落とす");
{
  const ev = cleanRun(8, 900);
  // 3本目と4本目のあいだ（拍から450msずれた位置）に、80msの短い音が入った
  ev.push({kind: "note", freq: 2600, durationMs: 80, startMs: 2 * 900 + 450});
  ev.sort((a, b) => a.startMs - b.startMs);
  const r = TF.analyze(ev, {});
  const dropped = r.items.filter(i => !i.keep);
  check("雑音が1つ落ちる", dropped.length === 1, "落ちた数=" + dropped.length);
  check("落ちたのは短い方", dropped.length === 1 && dropped[0].durationMs === 80);
  check("理由が付く", dropped.length === 1 && /拍から外れた短い音/.test(dropped[0].reason));
  check("本物は8本残る", r.items.filter(i => i.keep).length === 8);
}

console.log("■ 拍に乗っている短い音は拾い直す");
{
  const ev = cleanRun(8, 900);
  // 5本目が短く鳴ってセグメンタに捨てられた。ただし拍にはきちんと乗っている
  ev[4] = {kind: "reject", freq: 2300, durationMs: 100, startMs: 4 * 900, reason: "短すぎた"};
  const r = TF.analyze(ev, {});
  const revived = r.items[4];
  check("捨てられた音を拾い直す", revived.keep === true, "keep=" + revived.keep);
  check("理由が付く", /拍に乗っていたので拾い直した/.test(revived.reason));
  check("結局8本そろう", r.items.filter(i => i.keep).length === 8);
}

console.log("■ 拍に乗っていない捨て音は、そのまま捨てたままにする");
{
  const ev = cleanRun(6, 900);
  ev.push({kind: "reject", freq: 2800, durationMs: 60, startMs: 3 * 900 + 400, reason: "短すぎた"});
  ev.sort((a, b) => a.startMs - b.startMs);
  const r = TF.analyze(ev, {});
  const junk = r.items.find(i => i.durationMs === 60);
  check("拾い直さない", junk.keep === false);
  check("理由に「拍にも乗っていない」が入る", /拍にも乗っていない/.test(junk.reason));
}

console.log("■ 2本ぶんが繋がった疑いに印を付ける");
{
  const ev = cleanRun(6, 900);
  ev[2].durationMs = 900 * 1.9;          // 3本目が長すぎる
  const r = TF.analyze(ev, {});
  check("警告が付く", /繋がった疑い/.test(r.items[2].warn || ""), "warn=" + r.items[2].warn);
  check("それでも残す（人が判断する）", r.items[2].keep === true);
}

console.log("■ 音が少なくてテンポを測れないときは、判定を変えない");
{
  const r = TF.analyze(cleanRun(2, 900), {});
  check("beatMs は null", r.beatMs === null);
  check("2本ともそのまま残る", r.items.filter(i => i.keep).length === 2);
  check("説明が付く", /音が足りない/.test(r.note));
}

console.log("■ 拍に来たのに読めない音は「飛ばし」にする（除外ではない）");
{
  const ev = cleanRun(8, 900);
  // 5本目が拍どおりに来たが、音程が取れなかった（笛が鳴らなかった）
  ev[4] = {kind: "reject", freq: null, durationMs: 300, startMs: 4 * 900, reason: "音程が取れなかった"};
  const r = TF.analyze(ev, {});
  const it = r.items[4];
  check("扱いは skip（飛ばし）", it.action === "skip", "action=" + it.action);
  check("除外(drop)ではない", it.action !== "drop");
  check("理由が付く", /鳴らない笛として飛ばす/.test(it.reason));
  check("残り7本は採用", r.items.filter(i => i.action === "keep").length === 7);
}

console.log("■ 拍の位置に音が来なかったら、飛ばしを挿す");
{
  const ev = [];
  for (let i = 0; i < 8; i++) {
    if (i === 3) continue;               // 4本目がまったく鳴らなかった
    ev.push({kind: "note", freq: 2000 + i * 50, durationMs: 540, startMs: i * 900});
  }
  const r = TF.analyze(ev, {});
  check("テンポを900msと測れる", r.beatMs === 900, "beatMs=" + r.beatMs);
  check("穴を1つ見つける", r.missing.length === 1, "missing=" + JSON.stringify(r.missing));
  check("穴の位置は4本目（t=2700ms）", r.missing.length === 1 && r.missing[0].startMs === 2700);
  check("理由が付く", r.missing.length === 1 && /音が来なかった/.test(r.missing[0].reason));
}

console.log("■ 拍から外れた雑音は、飛ばしではなく除外のまま");
{
  const ev = cleanRun(8, 900);
  ev.push({kind: "note", freq: 2600, durationMs: 80, startMs: 2 * 900 + 450});
  ev.sort((a, b) => a.startMs - b.startMs);
  const r = TF.analyze(ev, {});
  const junk = r.items.find(i => i.durationMs === 80);
  check("扱いは drop（除外）", junk.action === "drop", "action=" + junk.action);
  check("穴は増えない", r.missing.length === 0, "missing=" + r.missing.length);
}

console.log("■ ★担体を持ち替える空白を、穴と誤解しない★");
{
  // スプール2枚を続けて吹く様子。25本 → 持ち替えで4秒あく → 24本
  const ev = []; let t = 0;
  for (let i = 0; i < 25; i++) { ev.push({kind:"note", freq:2000+i*20, durationMs:540, startMs:t}); t += 900; }
  t += 4000;
  for (let i = 0; i < 24; i++) { ev.push({kind:"note", freq:2000+i*20, durationMs:540, startMs:t}); t += 900; }
  const r = TF.analyze(ev, {});
  check("テンポは900ms", r.beatMs === 900);
  check("穴を1つも挿さない", r.missing.length === 0, "missing=" + r.missing.length);
  check("49本のまま", ev.length + r.missing.length === 49);
  check("全部そのまま採用", r.items.filter(i => i.action === "keep").length === 49);
}

console.log("■ 続けて2本が鳴らなかったときは、2本ぶん補う");
{
  const ev = [];
  for (let i = 0; i < 9; i++) {
    if (i === 3 || i === 4) continue;
    ev.push({kind:"note", freq:2000, durationMs:540, startMs:i*900});
  }
  const r = TF.analyze(ev, {});
  check("穴を2つ挿す", r.missing.length === 2, "missing=" + r.missing.length);
  check("合わせて9本になる", ev.length + r.missing.length === 9);
}

console.log("■ ★1本の音を切ってしまった断片は、拍の近くに来ていても採用しない★");
{
  // 実際に起きたこと（2026-08-06、スプールの録音）。4本目の418msの音は終わりぎわで
  // 83セント下がり、そこで切られて88msの断片ができた。断片は拍の近く（拍から143ms、
  // 561msの拍に対して25パーセント）に来ていたので「拾い直し」の対象になり、
  // 5本目として列に入って以降の並びが1つずつずれた。
  const beat = 561, ev = [];
  for (let i = 0; i < 8; i++) ev.push({kind:"note", freq:2000+i*40, durationMs:418, startMs:i*beat});
  ev.splice(4, 0, {kind:"reject", freq:1594, durationMs:88, startMs:3*beat + 418, reason:"短すぎた"});
  ev.sort((a,b) => a.startMs - b.startMs);
  const r = TF.analyze(ev, {});
  const kept = r.items.filter(i => i.action === "keep");
  check("断片を採用しない", kept.length === 8, "採用=" + kept.length + "本");
  const dropped = r.items.find(i => i.action === "drop");
  check("落とした理由を近さで説明する", /近すぎる/.test(dropped.reason || ""), dropped && dropped.reason);
  check("落とすのは短い方（418msの本物は残す）", dropped.durationMs === 88);
  check("穴は挿さない", r.missing.length === 0, "missing=" + r.missing.length);
}

console.log("■ ふつうの間隔（拍ちょうど）は近すぎるとみなさない");
{
  const r = TF.analyze(cleanRun(8, 900), {});
  check("8本すべて残る", r.items.filter(i => i.action === "keep").length === 8);
}

console.log("\n結果: ok " + ok + " / NG " + ng);
process.exit(ng ? 1 : 0);
