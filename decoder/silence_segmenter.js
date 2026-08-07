/* 無音区切りで笛を1本ずつに切り分ける状態機械。
 *
 * 音を続けて吹き、笛と笛の間に短い無音を置くだけで次の桁へ進む方式のために使う。
 * 判定に使うのは「笛の音域(loFloorHz以上)だけの帯域レベル[dB]」である。低い周波数を
 * 見ないので、話し声や空調の唸りには反応しにくい。
 *
 * 使い方は、毎フレーム feed(t, level, freq) を呼ぶだけである。t は経過時間[ms]、
 * level は帯域レベル[dB]、freq は今の推定周波数[Hz]（無ければ0）。
 * 戻り値は起きた出来事で、"note" なら1本ぶんが確定したことを表す。
 *
 * しきい値は環境ごとに違うので、開始直後の一定時間を暗騒音の測定にあて、そこから
 * 相対的に決める。鳴り始めと鳴り終わりで別のしきい値を使い（ヒステリシス）、境目で
 * ばたつかないようにしている。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SilenceSegmenter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULTS = {
    calibMs: 400,      // 開始直後、暗騒音を測る時間
    onMarginDb: 15,    // 暗騒音からこれだけ上なら「鳴っている」
    offMarginDb: 8,    // 暗騒音からこれだけ下回ったら「切れた」(ヒステリシス)
    absOnDb: -70,      // 暗騒音が静かすぎるときの下限
    onMs: 60,          // この時間続けて大きければ、鳴り始めと認める
    gapMs: 100,        // この時間続けて小さければ、1本の終わりと認める
                       // （実機で吹いた感触から180msより短くできると分かった。画面のつまみで変えられる）
    minNoteMs: 120,    // これより短い音は雑音として捨てる
    attackSkipMs: 50,  // 鳴り始めは音程が揺れるので、この時間ぶん測定しない
    endMs: 2500,       // 1本以上入ったあと、この時間無音なら入力の終わりとみなす
                       // （本数が分かっているときは呼び出し側で無効化してよい）
    // 音の変わり目でも区切る（0で無効）。息を切らずに続けて吹き、次の笛へ滑らせる
    // 読み方のための仕組みである。隣り合う笛が必ず違う音になる符号（隣接禁止）と
    // 組み合わせると、無音を置かなくても1本ずつ確実に切り分けられる。
    pitchSplitCents: 0,  // 今の音からこれだけ離れたら別の笛とみなす[セント]
    pitchStableMs: 70,   // 離れた音がこの時間続いたら、そこで区切る
    // 暗騒音[dB]を外から与える。与えると冒頭の測定を行わず、すぐ待機から始める。
    // 録音を読むときのためにある。録音は[* 冒頭が無音とは限らない]ので、
    // 始めの0.4秒を測る方式では、いきなり鳴っていると暗騒音を大きく見積もって
    // しまい、そのあとの音が1本も拾えなくなる。録音なら全体を先に見られるので、
    // 静かな側から2割にあたる値を暗騒音として渡す（fft_peak.noiseFloorDb）。
    noiseDb: null
  };

  /* 2つの周波数の隔たりをセントで返す。 */
  function centsBetween(a, b) {
    return 1200 * Math.log2(a / b);
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function create(options) {
    const opt = Object.assign({}, DEFAULTS, options || {});
    const state = {};

    /* 暗騒音から、鳴り始めと鳴り終わりのしきい値を決める。 */
    function setThresholds(noiseDb) {
      state.noiseDb = noiseDb;
      state.onDb = Math.max(noiseDb + opt.onMarginDb, opt.absOnDb);
      state.offDb = Math.max(noiseDb + opt.offMarginDb,
                             opt.absOnDb - opt.onMarginDb + opt.offMarginDb);
    }

    function reset() {
      state.phase = "calib";   // calib(暗騒音の測定) -> idle(待機) -> note(鳴っている)
      state.t0 = null;
      state.noise = [];
      state.noiseDb = null;
      state.onDb = null;
      state.offDb = null;
      state.onSince = null;    // 大きい状態が続き始めた時刻
      state.offSince = null;   // 小さい状態が続き始めた時刻
      state.noteStart = null;
      state.freqs = [];
      state.driftSince = null; // 今の音から離れ始めた時刻（音の変わり目の判定用）
      state.driftFreqs = [];   // 離れたあとの測定値。次の笛へ引き継ぐ
      state.count = 0;         // 確定した本数
      state.lastCommit = null; // 直近に確定した時刻
      if (typeof opt.noiseDb === "number") {
        setThresholds(opt.noiseDb);
        state.phase = "idle";  // 測る必要がないので、はじめから待機に入る
      }
    }
    reset();

    /* 1フレーム進める。戻り値は
     *   {type:"calibrating"} 暗騒音を測っている
     *   {type:"idle"}        待機している
     *   {type:"onset"}       鳴り始めを検出した
     *   {type:"sounding"}    鳴っている最中
     *   {type:"note", freq, durationMs, startMs} 1本ぶんが確定した
     *   {type:"reject", freq, durationMs, startMs, reason} 短すぎたので捨てた
     *   {type:"end"}         入力の終わり(長い無音)を検出した
     */
    function feed(t, level, freq) {
      if (state.t0 === null) state.t0 = t;
      const loud = state.onDb !== null && level >= state.onDb;
      const quiet = state.offDb !== null && level < state.offDb;

      if (state.phase === "calib") {
        state.noise.push(level);
        if (t - state.t0 < opt.calibMs) return {type: "calibrating"};
        // 暗騒音は中央値で代表する。突発的な物音に引きずられないため。
        setThresholds(median(state.noise));
        state.phase = "idle";
        return {type: "idle"};
      }

      if (state.phase === "idle") {
        if (loud) {
          if (state.onSince === null) state.onSince = t;
          if (t - state.onSince >= opt.onMs) {
            state.phase = "note";
            state.noteStart = state.onSince;   // 立ち上がりの時刻を始点にする
            state.freqs = [];
            state.onSince = null;
            state.offSince = null;
            return {type: "onset"};
          }
        } else {
          state.onSince = null;
        }
        // 1本以上入ったあとの長い無音は、入力の終わりとみなす
        if (state.count > 0 && state.lastCommit !== null &&
            t - state.lastCommit >= opt.endMs && state.onSince === null) {
          return {type: "end"};
        }
        return {type: "idle"};
      }

      // state.phase === "note"
      if (!quiet) {
        state.offSince = null;
        if (t - state.noteStart >= opt.attackSkipMs && freq) {
          // 音の変わり目でも区切る。今の笛の音（これまでの中央値）から大きく
          // 離れた音が一定時間続いたら、息を切らずに次の笛へ移ったとみなす。
          if (opt.pitchSplitCents > 0 && freq) {
            const base = median(state.freqs);
            if (base && Math.abs(centsBetween(freq, base)) >= opt.pitchSplitCents) {
              if (state.driftSince === null) { state.driftSince = t; state.driftFreqs = []; }
              state.driftFreqs.push(freq);
              if (t - state.driftSince >= opt.pitchStableMs) {
                // ここまでを1本として閉じ、離れ始めた時刻から次の1本を始める
                const closed = closeNote(state.driftSince, t, state.driftSince, state.driftFreqs);
                return closed;
              }
              return {type: "sounding"};
            }
            state.driftSince = null;
          }
          state.freqs.push(freq);
        }
        return {type: "sounding"};
      }
      state.driftSince = null;
      if (state.offSince === null) state.offSince = t;
      if (t - state.offSince < opt.gapMs) return {type: "sounding"};

      // 無音が続いたので1本ぶんを閉じる
      return closeNote(state.offSince, t, null, null);
    }

    /* 1本ぶんを閉じる。
     *   endAt      その笛が終わった時刻（長さの計算に使う）
     *   t          今の時刻
     *   nextStart  続けて次の笛を始めるならその開始時刻。null なら待機へ戻る
     *   nextFreqs  次の笛のために引き継ぐ測定値
     * 短すぎる音は雑音として捨てる。捨てるときも、次の笛の開始は引き継ぐ。 */
    function closeNote(endAt, t, nextStart, nextFreqs) {
      const duration = endAt - state.noteStart;
      // [* いま閉じる音の開始時刻を、書き換える前に控える]。下で続けて次の音を始めるとき
      // state.noteStart を次の音の開始へ進めるので、そのあとで読むと[* 次の音の開始]を
      // 返してしまう。息を切らずに吹いた列ではこれが全体にずれとして残り、テンポの判定が
      // 狂う（隣り合う音の間隔が0と出て、本物の音を「近すぎる」と誤って落とした）。
      const startAt = state.noteStart;
      const f = median(state.freqs);
      const cont = nextStart !== null;
      state.onSince = null;
      state.offSince = null;
      state.driftSince = null;
      state.freqs = cont ? (nextFreqs || []) : [];
      if (cont) {
        state.phase = "note";
        state.noteStart = nextStart;
      } else {
        state.phase = "idle";
      }
      // 捨てるときも[* 何を捨てたかを返す]。呼び出し側で、あとからテンポを見て
      // 拾い直したり、画面に出して人が判断したりできるようにするためである
      // （2026-08-06、テンポを使う後処理のために足した）。
      if (duration < opt.minNoteMs || !f) {
        return {type: "reject", freq: f || null, durationMs: duration, startMs: startAt,
                reason: !f ? "音程が取れなかった" : "短すぎた"};
      }
      state.count += 1;
      state.lastCommit = t;
      return {type: "note", freq: f, durationMs: duration, startMs: startAt};
    }

    return {
      feed: feed,
      reset: reset,
      options: opt,
      thresholds: () => ({noiseDb: state.noiseDb, onDb: state.onDb, offDb: state.offDb}),
      phase: () => state.phase,
      count: () => state.count
    };
  }

  return {create: create, DEFAULTS: DEFAULTS};
});
