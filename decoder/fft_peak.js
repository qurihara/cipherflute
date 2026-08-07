/* 録音を、笛の音域の中でいちばん強い山を追う方式で解析する。
 *
 * なぜ要るか
 * ----------
 * これまで録音の読み込みには、自己相関にもとづく音程検出（pitchy の findPitch）を
 * 使っていた。ところがこれは[* 符号の最低音 G#6（1661Hz）を誤る]。スプールの録音では
 * 3992Hz という無関係な値を返し、49本中5本ある G#6 が読めないために復元できなかった。
 *
 * 同じ録音を、笛の音域だけを見てFFTの山を追う方式で解析すると 1679Hz と正しく読める。
 * scripts/analyze_recording.py がその方式で、実際に48本を読んで復号まで通った。
 * その解析器をブラウザへ移したものがこれである（2026-08-06、v12）。
 *
 * 要点は[* 音域の外は見ない]ことである。話し声や空調は音域より低い方に、擦れる音は
 * 高い方に出るので、見る範囲を絞るだけで雑音がかなり落ちる。自己相関は信号全体の
 * 周期を探すため、この絞り込みができない。
 *
 * 使い方
 *   const r = FftPeak.track(samples, 44100, {loHz:1479, hiHz:3520});
 *   // r.times[i] … その窓の始まり[ms]、r.freqs[i] … 山の周波数[Hz]、r.levels[i] … 山の強さ[dB]
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FftPeak = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULTS = {
    loHz: 1500,   // 見る音域の下
    hiHz: 3400,   // 見る音域の上
    win: 4096,    // 窓の長さ[サンプル]。44.1kHzで約93ms
                  // 8192（約186ms）にすると、息を切らずに続けて吹いたときの
                  // 音の変わり目が窓の中で平均化され、2本の笛が1つに繋がる
    hop: 512      // 窓をずらす幅[サンプル]。約11.6ms
  };

  /* その場で書き換える基数2の高速フーリエ変換。
   * 長さは2のべき乗でなければならない。re と im は同じ長さの実数配列である。 */
  function fft(re, im) {
    const n = re.length;
    if (n !== im.length || (n & (n - 1)) !== 0) {
      throw new Error("FFTの長さは2のべき乗でなければならない（いまは" + n + "）");
    }
    // 添字をビット反転の順に並べ替える
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < half; j++) {
          const ar = re[i + j], ai = im[i + j];
          const br = re[i + j + half], bi = im[i + j + half];
          const vr = br * cr - bi * ci;
          const vi = br * ci + bi * cr;
          re[i + j] = ar + vr; im[i + j] = ai + vi;
          re[i + j + half] = ar - vr; im[i + j + half] = ai - vi;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nr;
        }
      }
    }
    return {re: re, im: im};
  }

  /* ハン窓。numpy.hanning と同じ定義（両端がちょうど0になる） */
  function hanning(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  }

  /* スペクトルの配列から、音域の中でいちばん強い山を返す。
   *
   * spec は[* 振幅でもデシベルでもよい]。どちらも単調な変換なので、山の位置は変わらない。
   * AnalyserNode の getFloatFrequencyData（デシベル）をそのまま渡せるので、
   * マイクで拾うときも録音を読むときも[* まったく同じ判定]ができる。
   *
   * 山の頂点は両隣を使った放物線で補間する。ビンの幅より細かく読めるので、
   * マイク側の分解能（44.1kHz・窓4096で約10.8Hz）でも十分な精度になる。
   */
  function peakInBand(spec, binHz, loHz, hiHz) {
    const k0 = Math.max(1, Math.ceil(loHz / binHz));
    const k1 = Math.min(spec.length - 1, Math.floor(hiHz / binHz));
    if (k1 <= k0) return null;
    let best = k0, bestVal = -Infinity;
    for (let k = k0; k <= k1; k++) {
      if (spec[k] > bestVal) { bestVal = spec[k]; best = k; }
    }
    if (!isFinite(bestVal)) return null;
    let f = best * binHz;
    if (best > k0 && best < k1) {
      const a = spec[best - 1], b = spec[best], c = spec[best + 1];
      const den = a - 2 * b + c;
      if (den !== 0 && isFinite(den)) {
        const d = (a - c) / (2 * den);
        // 補間が隣のビンを越えたら信じない（山でない所を拾っている）
        if (Math.abs(d) <= 1) f = (best + d) * binHz;
      }
    }
    return {freq: f, level: bestVal, bin: best};
  }

  /* 窓ごとに、音域の中でいちばん強い山とその強さを返す。 */
  function track(x, sampleRate, options) {
    const opt = Object.assign({}, DEFAULTS, options || {});
    const win = opt.win, hop = opt.hop;
    const w = hanning(win);
    const binHz = sampleRate / win;
    // 見る範囲のビン。Python版（freqs >= lo & freqs <= hi）と同じ切り方にする
    const k0 = Math.max(0, Math.ceil(opt.loHz / binHz));
    const k1 = Math.min(win >> 1, Math.floor(opt.hiHz / binHz));
    if (k1 <= k0) throw new Error("音域の指定が窓に対して狭すぎる");
    const re = new Float64Array(win), im = new Float64Array(win);
    const mag = new Float64Array(k1 + 2);
    const times = [], freqs = [], levels = [];
    for (let i = 0; i + win < x.length; i += hop) {
      for (let k = 0; k < win; k++) { re[k] = x[i + k] * w[k]; im[k] = 0; }
      fft(re, im);
      for (let k = k0; k <= k1; k++) {
        mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      }
      // 山を拾うところは[* マイクの側とまったく同じ関数]を通す
      const pk = peakInBand(mag, binHz, opt.loHz, opt.hiHz);
      times.push(i / sampleRate * 1000);
      freqs.push(pk ? pk.freq : k0 * binHz);
      levels.push(20 * Math.log10((pk ? pk.level : 0) + 1e-12));
    }
    return {times: times, freqs: freqs, levels: levels, binHz: binHz};
  }

  /* 静かな側から数えて指定の割合にあたる値を、暗騒音とみなして返す。
   * 録音は冒頭が無音とは限らないので、全体の分布から決める方が確かである
   * （その場のマイクのように「始めの0.4秒を測る」ことができない）。
   *
   * ★既定を1割にしてある★。2割にすると、録音によって -3.6dB から -26.0dB まで
   * 22dBもぶれた。息を継がずに吹き続けた録音では[* 鳴っている時間が全体の8割近くを占める]
   * ので、2割の位置がすでに音の裾に入ってしまう。1割なら4つの録音すべてで
   * -27dB から -28dB に収まり、これが本当の暗騒音である（2026-08-06に実測）。
   * この差は復号の成否を分ける。2割で見積もると、弱く鳴った笛（0.0dB）が
   * しきい値（2.7dB）に届かず、1本まるごと落ちて以降の並びがずれた。 */
  function noiseFloorDb(levels, percent) {
    if (!levels.length) return null;
    const p = (percent === undefined ? 10 : percent) / 100;
    const s = Array.prototype.slice.call(levels).sort((a, b) => a - b);
    const pos = p * (s.length - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  return {track: track, peakInBand: peakInBand, fft: fft, hanning: hanning,
          noiseFloorDb: noiseFloorDb, DEFAULTS: DEFAULTS};
});
