/* fft_peak の検査。node docs/cipher/fft_peak.test.js で走る。 */
const FP = require("./fft_peak.js");

let ok = 0, ng = 0;
function check(label, cond, extra) {
  if (cond) { ok++; console.log("  ok   " + label); }
  else { ng++; console.log("  NG   " + label + (extra ? "  → " + extra : "")); }
}

/* 正弦波を作る。振幅と周波数を指定できる。 */
function tone(hz, sec, sr, amp) {
  const n = Math.round(sec * sr);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = (amp === undefined ? 1 : amp) * Math.sin(2 * Math.PI * hz * i / sr);
  return x;
}
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float64Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function silence(sec, sr) { return new Float64Array(Math.round(sec * sr)); }

console.log("■ FFTそのものの正しさ");
{
  // 素朴な離散フーリエ変換と突き合わせる
  const n = 64;
  const re = new Float64Array(n), im = new Float64Array(n);
  const src = [];
  for (let i = 0; i < n; i++) {
    const v = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1);
    src.push(v); re[i] = v; im[i] = 0;
  }
  FP.fft(re, im);
  let worst = 0;
  for (let k = 0; k < n; k++) {
    let dr = 0, di = 0;
    for (let i = 0; i < n; i++) {
      const a = -2 * Math.PI * k * i / n;
      dr += src[i] * Math.cos(a);
      di += src[i] * Math.sin(a);
    }
    worst = Math.max(worst, Math.abs(dr - re[k]), Math.abs(di - im[k]));
  }
  check("素朴な離散フーリエ変換と一致する", worst < 1e-9, "最大の差=" + worst);

  let threw = false;
  try { FP.fft(new Float64Array(3), new Float64Array(3)); } catch { threw = true; }
  check("2のべき乗でない長さは拒む", threw);
}

console.log("■ 音域の中の山を、ビンの幅より細かく読む");
{
  const sr = 44100;
  // 2000Hz はビンの中心（44100/4096=10.77Hz刻み）から外れているので、
  // 放物線で補間できているかどうかがそのまま出る
  const r = FP.track(tone(2000, 0.5, sr), sr, {loHz: 1500, hiHz: 3400});
  const mid = r.freqs[Math.floor(r.freqs.length / 2)];
  check("2000Hzを±2Hzで読む", Math.abs(mid - 2000) < 2, mid.toFixed(1) + "Hz");
  check("ビンの幅は約10.8Hz（補間なしでは±5Hzずれうる）", Math.abs(r.binHz - 10.766) < 0.01);
}

console.log("■ ★符号の最低音 G#6（1661Hz）を正しく読む★（自己相関方式が誤った音）");
{
  const sr = 44100;
  const r = FP.track(tone(1661, 0.5, sr), sr, {loHz: 1479, hiHz: 3520});
  const mid = r.freqs[Math.floor(r.freqs.length / 2)];
  check("1661Hzを±3Hzで読む", Math.abs(mid - 1661) < 3, mid.toFixed(1) + "Hz");
}

console.log("■ 音域の外は見ない");
{
  const sr = 44100;
  // 300Hzの唸り（大きい）と2500Hzの笛（小さい）を重ねる。
  // 自己相関だと低い方の周期に引かれるが、音域を絞れば笛が残る。
  const x = new Float64Array(Math.round(0.5 * sr));
  const hum = tone(300, 0.5, sr, 1.0), flute = tone(2500, 0.5, sr, 0.05);
  for (let i = 0; i < x.length; i++) x[i] = hum[i] + flute[i];
  const r = FP.track(x, sr, {loHz: 1500, hiHz: 3400});
  const mid = r.freqs[Math.floor(r.freqs.length / 2)];
  check("低い唸りに引かれず2500Hzを読む", Math.abs(mid - 2500) < 5, mid.toFixed(1) + "Hz");
}

console.log("■ 鳴っているところと無音とで、強さがはっきり分かれる");
{
  const sr = 44100;
  const x = concat([silence(0.4, sr), tone(2093, 0.6, sr, 0.3), silence(0.4, sr)]);
  const r = FP.track(x, sr, {loHz: 1500, hiHz: 3400});
  const at = ms => r.levels[r.times.findIndex(t => t >= ms)];
  check("無音のところは静か", at(100) < -60, at(100).toFixed(1) + "dB");
  check("鳴っているところは大きい", at(600) > -20, at(600).toFixed(1) + "dB");
  check("その差は40dB以上ある", at(600) - at(100) > 40);
}

console.log("■ 窓の長さと時間のきざみ");
{
  const sr = 44100;
  const r = FP.track(tone(2000, 1.0, sr), sr, {win: 4096, hop: 512});
  check("きざみは約11.6ms", Math.abs(r.times[1] - r.times[0] - 11.61) < 0.01,
        (r.times[1] - r.times[0]).toFixed(2) + "ms");
  check("窓に満たない末尾は返さない", r.times.length === Math.ceil((sr - 4096) / 512),
        r.times.length + "窓");
}

console.log("■ スペクトルから山を拾う（マイクと録音で共通の関数）");
{
  const binHz = 44100 / 4096;                        // 約10.77Hz
  // 2000Hz にちょうど山がある形を作る（両隣が対称に低い）
  const spec = new Float64Array(2049).fill(-120);
  const k = Math.round(2000 / binHz);
  spec[k - 1] = -30; spec[k] = -20; spec[k + 1] = -30;
  const p = FP.peakInBand(spec, binHz, 1500, 3400);
  check("山の位置を返す", p.bin === k, "bin=" + p.bin);
  check("両隣が対称なら補間しても中心のまま",
        Math.abs(p.freq - k * binHz) < 1e-6, p.freq.toFixed(2));
  check("山の強さを返す", p.level === -20);

  // 右隣が高ければ、山の頂点は右へ寄る
  spec[k + 1] = -25;
  const q = FP.peakInBand(spec, binHz, 1500, 3400);
  check("右が高ければ右へ寄る", q.freq > k * binHz, q.freq.toFixed(2));
  check("寄る量は1ビン以内", q.freq - k * binHz < binHz, (q.freq - k*binHz).toFixed(2));

  // 音域の外にもっと強い山があっても、拾わない
  const spec2 = new Float64Array(2049).fill(-120);
  spec2[Math.round(300 / binHz)] = 0;                // 音域より下の唸り（最強）
  spec2[Math.round(2500 / binHz)] = -40;             // 音域の中の笛（弱い）
  const r = FP.peakInBand(spec2, binHz, 1500, 3400);
  check("音域の外は見ない", Math.abs(r.freq - 2500) < binHz, r.freq.toFixed(1) + "Hz");

  check("音域が狭すぎれば null", FP.peakInBand(spec, binHz, 2000, 2000) === null);
  check("全部が無限小なら null",
        FP.peakInBand(new Float64Array(100).fill(-Infinity), binHz, 200, 400) === null);
}

console.log("■ 暗騒音（静かな側から数えた割合）");
{
  const v = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  check("20パーセントの位置を線形に補う", Math.abs(FP.noiseFloorDb(v, 20) - 1.8) < 1e-9,
        String(FP.noiseFloorDb(v, 20)));
  check("順不同でも同じ", FP.noiseFloorDb([9, 3, 1, 7, 5], 50) === 5);
  check("空なら null", FP.noiseFloorDb([]) === null);
  check("既定は1割の位置", FP.noiseFloorDb(v) === FP.noiseFloorDb(v, 10),
        String(FP.noiseFloorDb(v)));

  // 吹き続けた録音を模す。無音は全体の15パーセントしかなく、残りは鳴っている。
  // 2割の位置を取ると音の裾（-20dB）を暗騒音とみなしてしまう。
  const run = [];
  for (let i = 0; i < 15; i++) run.push(-60);            // 無音
  for (let i = 0; i < 10; i++) run.push(-20);            // 弱く鳴った笛
  for (let i = 0; i < 75; i++) run.push(0);              // ふつうに鳴った笛
  check("1割なら無音側に留まる", FP.noiseFloorDb(run, 10) === -60, String(FP.noiseFloorDb(run, 10)));
  check("2割だと音の裾に入ってしまう", FP.noiseFloorDb(run, 20) === -20, String(FP.noiseFloorDb(run, 20)));
}

console.log("■ 続けて吹いた2本を、窓4096なら別々に追える");
{
  const sr = 44100;
  // 息を切らずに 2093Hz → 2489Hz と滑らせた（無音がない）
  const x = concat([tone(2093, 0.5, sr, 0.3), tone(2489, 0.5, sr, 0.3)]);
  const r = FP.track(x, sr, {win: 4096, hop: 512, loHz: 1500, hiHz: 3400});
  const at = ms => r.freqs[r.times.findIndex(t => t >= ms)];
  check("前半は2093Hz", Math.abs(at(200) - 2093) < 5, at(200).toFixed(1));
  check("後半は2489Hz", Math.abs(at(750) - 2489) < 5, at(750).toFixed(1));
  // 変わり目の前後で、窓の長さ（93ms）を大きく超えて引きずらないこと
  check("変わり目から100ms後にはもう次の音", Math.abs(at(600) - 2489) < 5, at(600).toFixed(1));
}

console.log("");
console.log(ng === 0 ? "すべて通った（" + ok + "件）" : "NGが" + ng + "件（通ったのは" + ok + "件）");
process.exit(ng === 0 ? 0 : 1);
