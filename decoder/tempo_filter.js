/* 吹いたテンポを手がかりに、雑音まじりの音の列を整える。
 *
 * なぜ要るか
 * ----------
 * 不調な笛が混じると、無音区切りの自動送りが崩れる。音がうまく鳴らずに短い雑音が
 * 入ったり、まったく違う高さに聞こえたりするためである。しきい値（これより短ければ
 * 無視）だけでは、短いが本物の音と、長めの雑音を見分けられない。
 *
 * 手がかりになるのが[* テンポ]である。うまく吹けているとき、笛は almost 一定の間隔で
 * 入ってくる。そこで、確かな音どうしの間隔から拍を測り、その拍に乗らない短い音を
 * 雑音とみなす。人が「調子よく吹けているときのリズム」で判断しているのと同じことを、
 * 機械にさせる。
 *
 * 判断はすべて[* 提案]であって、決定ではない。返り値には理由を添えるので、画面で
 * 人が見て、必要なら手で有効・無効を切り替えられるようにする。
 *
 * 使い方:
 *   const out = TempoFilter.analyze(events, {});
 *   out.items      各音の判定（keep / drop と理由）
 *   out.beatMs     測ったテンポ（拍の間隔[ms]）。測れなければ null
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TempoFilter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULTS = {
    // 拍から見て、この割合より内側なら「拍に乗っている」とみなす。
    // 0.5 は隣の拍とのちょうど中間なので、そこに近い値にすると何でも
    // 「乗っている」ことになってしまう（0.45 で実際に誤判定した）。
    // 人が吹くときのばらつきを考えて ±30% に取る。
    onBeatTol: 0.30,
    // 拍のこの割合より短い音は、拍に乗っていなければ雑音とみなす
    shortRatio: 0.5,
    // 長さが拍のこの倍を超えたら「2本ぶんが繋がった疑い」を立てる
    mergedRatio: 1.7,
    // テンポを測るのに最低これだけの音が要る
    minForTempo: 3,
    // 隣り合う音の間隔がこの拍数までなら「あいだで鳴らなかった笛がある」とみなす。
    // これを超える空白は、担体の持ち替えや休憩と考えて何も挿さない。
    maxGapBeats: 4,
    // 隣り合う音がこの拍数より近いときは、2本の笛ではなく1本の音を切ってしまったとみなす。
    // 笛は1本ずつ吹くので、1つの拍に2本が入ることはない。
    minSpacingBeats: 0.5
  };

  function median(xs) {
    if (!xs.length) return null;
    const a = xs.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /* 音の列を調べ、1つずつに判定を付ける。
   *
   * events は {kind:"note"|"reject", freq, durationMs, startMs} の配列である。
   * kind が "note" のものは、セグメンタが確かだと判断した音である。 */
  function analyze(events, options) {
    const opt = Object.assign({}, DEFAULTS, options || {});
    const items = events.map((e, i) => ({
      index: i,
      kind: e.kind,
      freq: e.freq == null ? null : e.freq,
      durationMs: e.durationMs == null ? null : e.durationMs,
      startMs: e.startMs == null ? null : e.startMs,
      keep: e.kind === "note",
      reason: e.kind === "note" ? "" : (e.reason || "短すぎた")
    }));

    // テンポは「確かな音」どうしの間隔から測る。雑音を混ぜると拍が狂う。
    const sure = items.filter(it => it.kind === "note" && it.startMs != null);
    let beatMs = null;
    if (sure.length >= opt.minForTempo) {
      const gaps = [];
      for (let i = 1; i < sure.length; i++) gaps.push(sure[i].startMs - sure[i - 1].startMs);
      beatMs = median(gaps);
    }
    if (!beatMs || beatMs <= 0) {
      return {items, beatMs: null, note: "テンポを測るには音が足りない（判定は変えていない）"};
    }

    // 拍に乗っているかどうかで、[* 扱いを3つに分ける]。
    //
    //   drop（除外）… 拍から外れた短い音。咳や物音であって笛ではないので、
    //                 位置ごと取り除く。本数には数えない。
    //   skip（飛ばし）… 拍には乗っているのに読めない音。[* そこに笛はあったが鳴らなかった]
    //                 ということなので、位置を保ったまま消失として扱い、パリティで訂正させる。
    //   keep（採用）… そのまま使う。
    //
    // この区別は栗原さんの指摘による（2026-08-06）。以前はどちらも「除外」にしていたので、
    // 笛が鳴らなかったときに本数が1つ減り、パリティで直せる誤りを直せなくしていた。
    for (const it of items) {
      it.action = it.keep ? "keep" : "drop";
      if (it.startMs == null) continue;
      const phase = nearestBeatDistance(it.startMs, sure, beatMs);
      const onBeat = phase != null && phase <= beatMs * opt.onBeatTol;
      const short = it.durationMs != null && it.durationMs < beatMs * opt.shortRatio;

      if (it.kind === "reject") {
        if (onBeat && it.freq) {
          it.keep = true; it.action = "keep";
          it.reason = "拍に乗っていたので拾い直した";
        } else if (onBeat) {
          // 拍には来ているのに音程が取れなかった＝笛が鳴らなかった
          it.keep = false; it.action = "skip";
          it.reason = "拍に来たが読めなかった（鳴らない笛として飛ばす）";
        } else {
          it.keep = false; it.action = "drop";
          it.reason = (it.reason || "短すぎた") + "／拍にも乗っていない（雑音）";
        }
      } else if (!onBeat && short) {
        it.keep = false; it.action = "drop";
        it.reason = "拍から外れた短い音（雑音の疑い）";
      }

      if (it.keep && it.durationMs != null && it.durationMs > beatMs * opt.mergedRatio) {
        it.warn = "長い（2本ぶんが繋がった疑い）";
      }
    }

    // [* 1つの拍に2本の笛は入らない]。近すぎる隣り合わせが残っていたら、それは別の笛では
    // なく、1本の音の途中を切ってしまったものである。短い方を落とす。
    //
    // 実例（2026-08-06）。4本目の G#6（418ms）は終わりぎわで83セント下がり、音の変わり目
    // として切られて88msの断片ができた。断片は拍の近くに来ていたので上の判定で拾い直され、
    // 5本目として列に入り、以降の並びが1つずつずれて復号できなくなった。
    //
    // ここでも[* 全体に拍の格子を敷かず、隣り合う2つだけを見る]。担体を持ち替えて数秒空くと
    // 格子は狂うが、隣り合う間隔なら狂わない（v9で学んだのと同じ理由である）。
    for (;;) {
      const kept = items.filter(it => it.keep && it.startMs != null);
      let victim = null;
      for (let i = 1; i < kept.length; i++) {
        if (kept[i].startMs - kept[i - 1].startMs >= beatMs * opt.minSpacingBeats) continue;
        const a = kept[i - 1], b = kept[i];
        victim = (a.durationMs || 0) < (b.durationMs || 0) ? a : b;
        break;
      }
      if (!victim) break;
      victim.keep = false;
      victim.action = "drop";
      victim.reason = "隣の音と近すぎる（1本の音を切ってしまったとみなす）";
    }

    // [* 拍の位置に音がまったく来なかった]場合も、笛が鳴らなかったということである。
    // ただし穴を埋めるのは[* 隣り合う音のあいだ]に限り、しかも[* 少しの穴だけ]にする。
    //
    // 全体に1本の拍の格子を敷いてはいけない。担体を持ち替えるときに数秒空くと、
    // それ以降の音がどれも格子に乗らなくなり、拍という拍がすべて穴に見える。
    // スプール2枚（25本＋持ち替え4秒＋24本）で試したところ、49本が76本に膨れた
    // （2026-08-06、栗原さんの問いで気づいた）。
    //
    // そこで、隣り合う音の間隔が拍の何倍かを見て、2〜maxGapBeats 倍のときだけ
    // 「そのあいだで鳴らなかった笛がある」と判断する。それより大きく空いたときは
    // 持ち替えや休憩とみなし、何も挿さない。
    const missing = [];
    const live = items.filter(it => it.action !== "drop" && it.startMs != null);
    for (let i = 1; i < live.length; i++) {
      const gap = live[i].startMs - live[i - 1].startMs;
      const k = Math.round(gap / beatMs);
      if (k < 2 || k > opt.maxGapBeats) continue;      // 1拍なら正常、開きすぎは持ち替え
      // 間隔が拍のちょうど整数倍に近いときだけ信じる（半端なら別の理由で空いている）
      if (Math.abs(gap - k * beatMs) > beatMs * opt.onBeatTol) continue;
      for (let j = 1; j < k; j++) {
        missing.push({after: live[i - 1].index,
                      startMs: live[i - 1].startMs + j * beatMs,
                      reason: "この拍に音が来なかった（鳴らない笛として飛ばす）"});
      }
    }
    return {items, beatMs, missing, note: ""};
  }

  /* いちばん近い拍からの隔たり[ms]。拍の格子は、確かな音の並びから作る。 */
  function nearestBeatDistance(t, sure, beatMs) {
    if (!sure.length) return null;
    const t0 = sure[0].startMs;
    const k = Math.round((t - t0) / beatMs);
    return Math.abs(t - (t0 + k * beatMs));
  }

  return {analyze, DEFAULTS, _median: median};
});
