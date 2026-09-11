/* CipherFlute 読み取り部（公開ページ共通）
 *
 * 復号ページ（index.html）と秘密分散のページ（share.html）が共有する。
 * マイクを開き、笛の音域の中でいちばん強い山を追い（fft_peak.js）、無音や音の変わり目で
 * 1本ずつに切り（silence_segmenter.js）、吹き終わりにテンポで雑音と鳴らなかった笛を
 * 見分け（tempo_filter.js）、周波数の列を利用者のページへ渡す。復号そのものと照合
 * （SHA-256・goto_enc・c=）もここにある。
 *
 * ページの側は、決まった id の要素を置き、CipherReader.create({onSequence}) を呼ぶ。
 *   必ず要るもの … startBtn status hz noteName cents clarBar
 *                  autoDot autoLevel autoHint autoSeq autoStatus autoTempo
 *                  autoStartBtn autoSkipBtn autoUndoBtn autoClearBtn
 *                  gapRange gapVal pitchSplit splitRange splitVal stableRange stableVal
 *                  minnoteRange minnoteVal
 *                  successOverlay successSub successGo successClose
 *   あれば使うもの … recDot recBeat recBeatVal recStartBtn recStatus recCount（その場で録音する入口）
 *                  cipherHash（照合用SHA-256の入力欄）
 *
 * 開発用のページ（dev.html）はこれを使わず、拍に合わせる入口・1本ずつ確定する入口・
 * 録音ファイルの読み込み・期待する音列との突き合わせ・測定値の書き出しを持っている。
 * 実演の録画を流し込む demoaudio= もそちらにだけある。
 *
 * 読み取りの方式についての判断は、次のとおりである（開発の記録から要点だけ写した）。
 *   * 音の高さは音域の中の山だけを見る。自己相関にもとづく検出は符号の最低音 G#6 に
 *     無関係な値を返すことがあり、使えない。
 *   * 音域の外の音は列から消さず、読めなかった印を付けて残す。消すと位置が詰まって
 *     以降がずれる。飛ばし（消失）か雑音かは、拍に乗っているかで決める。
 *   * 入力の終わりは利用者が決める。桁数に達したら自動で確定する作りにはしない。
 *     利用者に桁数を暗黙に教えてしまうためである。
 */
(function () {
  "use strict";

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const el = id => document.getElementById(id);
  const has = id => !!document.getElementById(id);
  const MIC_ON_DB = -75;         // 山がこれより強ければ「鳴っている」とみなす
  const CARRIER_GAP_MS = 5000;   // 録音と録音の間に置く持ち替えの空白（拍の4倍より確実に長い）

  function create(opts) {
    opts = opts || {};
    const onSequence = opts.onSequence || function () {};   // 吹き終わり (freqs, meta)
    const onReset = opts.onReset || function () {};         // 読み直しの前に、結果の表示を消す

    const st = {
      audioCtx: null, analyser: null, freqData: null, running: false, micStream: null,
      config: null, override: {}, loFloorHz: 1200, hiCeilHz: 3600,
      refMeasuredHz: null,           // 実際に吹いた基準笛の周波数（1本目）。以後の表示の物差し
      sha256: "", gotoUrl: "", gotoEnc: "", packEnc: "",
      segOptions: {},                // 区切りの調整（URLから）
      live: { freq: 0, bandDb: -120 },
    };
    const auto = { active: false, seg: null, seq: [], t0: 0 };
    const rec = { active: false, mr: null, chunks: [], t0: 0, timer: null, beats: 0 };

    // ---------------------------------------------------------------- URLの引数
    // ? のクエリと # のフラグメントの両方を読む。フラグメントはサーバへ送られないので、
    // 設定はそちらに置くのが望ましい。同じ名前ならフラグメントを優先する。
    (function initParams() {
      const search = new URLSearchParams(location.search);
      const frag = new URLSearchParams(location.hash.replace(/^#/, ""));
      const q = name => frag.has(name) ? frag.get(name) : search.get(name);
      const num = (name, key) => {
        const v = q(name);
        if (v !== null && /^\d+(\.\d+)?$/.test(v)) st.segOptions[key] = parseFloat(v);
      };
      num("gap", "gapMs");                    // 区切りとみなす無音の長さ[ms]
      num("onmargin", "onMarginDb");          // 暗騒音から何dB上を「鳴っている」とするか
      num("minnote", "minNoteMs");            // これより短い音は雑音として捨てる[ms]
      num("splitcents", "pitchSplitCents");   // 音の変わり目とみなす隔たり[セント]
      num("stablems", "pitchStableMs");       // 離れた音がこの時間続いたら区切る[ms]
      const setRange = (id, valId, unit, v, lo, hi) => {
        if (v !== undefined && v !== null) el(id).value = String(Math.max(lo, Math.min(hi, v)));
        el(valId).textContent = el(id).value + " " + unit;
      };
      setRange("gapRange", "gapVal", "ms", st.segOptions.gapMs, 60, 400);
      setRange("splitRange", "splitVal", "セント", st.segOptions.pitchSplitCents, 10, 200);
      setRange("stableRange", "stableVal", "ms", st.segOptions.pitchStableMs, 20, 200);
      setRange("minnoteRange", "minnoteVal", "ms", st.segOptions.minNoteMs, 40, 300);
      if (q("pitchsplit") === "1") el("pitchSplit").checked = true;

      st.sha256 = (q("sha256") || q("hash") || "").trim();
      if (has("cipherHash") && st.sha256) el("cipherHash").value = st.sha256;

      const mode = q("mode");
      if (mode === "symbols" || mode === "sequential") st.override.mode = mode;
      const parity = q("parity");
      if (parity !== null && /^\d+$/.test(parity)) st.override.ecc_parity = parseInt(parity, 10);
      const noteRe = /^[A-Ga-g][#b]?-?\d+$/;
      const ref = q("ref");
      if (ref && noteRe.test(ref)) st.override.reference_note = ref;
      const lo = q("lo");
      if (lo && noteRe.test(lo)) st.override.lo_note = lo;
      const hi = q("hi");
      if (hi && noteRe.test(hi)) st.override.hi_note = hi;
      const step = q("step");
      if (step !== null && /^\d+(\.\d+)?$/.test(step)) st.override.step_cents = parseFloat(step);
      const useref = q("useref");
      if (useref === "0" || useref === "false") st.override.use_reference = false;
      const norepeat = q("norepeat");         // 隣り合う笛が同じ音にならない符号化で読む
      if (norepeat === "1" || norepeat === "true") st.override.no_repeat = true;
      const g = q("goto");                    // 平文の遷移先。URLに見えるので守秘性はない
      if (g && /^https?:\/\//i.test(g)) st.gotoUrl = g;
      const ge = q("goto_enc");               // 秘密で暗号化された遷移先
      if (ge) st.gotoEnc = ge.trim();
      const pk = q("c");                      // 設定一式を秘密で包んだもの
      if (pk) st.packEnc = pk.trim();
    })();

    const configReady = fetch("cipher_config.json").then(r => {
      if (!r.ok) throw new Error("設定を読み込めません (" + r.status + ")");
      return r.json();
    }).then(cfg => {
      st.config = Object.assign(cfg, st.override);
      try { st.loFloorHz = window.CipherCodec.noteToFreq(st.config.lo_note) * Math.pow(2, -2 / 12); } catch (_) {}
      try { st.hiCeilHz = window.CipherCodec.noteToFreq(st.config.hi_note) * Math.pow(2, 2 / 12); } catch (_) {}
      return st.config;
    }).catch(e => { el("status").textContent = e.message; return null; });

    // ---------------------------------------------------------------- 音名
    function refFreqHz() {
      if (st.refMeasuredHz) return st.refMeasuredHz;
      try { return window.CipherCodec.noteToFreq(st.config.reference_note); } catch (_) { return null; }
    }
    /* 基準笛との比で読む。復号の判定とまったく同じ計算をして、画面表示に使う。
     * 判定は「基準笛との周波数比」で行うので、表示だけ絶対音高だと食い違う。 */
    function relativeRead(f) {
      if (!f || !st.config || !window.CipherCodec) return null;
      let table;
      try { table = window.CipherCodec.slots(st.config); } catch (_) { return null; }
      if (!table || !table.length) return null;
      const ref = refFreqHz();
      if (!ref) return null;
      let nominal;
      try { nominal = window.CipherCodec.noteToFreq(st.config.reference_note); } catch (_) { return null; }
      let best = null;
      for (const s of table) {
        const ratio = s.freq_hz / nominal;
        const c = 1200 * Math.log2((f / ref) / ratio);
        if (!best || Math.abs(c) < Math.abs(best.cents)) best = { note: s.nearest_note, cents: Math.round(c), slot: s.index };
      }
      return best;
    }
    /* 符号の音域（上下に半音の余裕）の外は「読めなかった」として null を返す。
     * オクターブ単位で引き戻して倍音を救う手は、不調の音と本物の倍音を区別できず害が出た。 */
    function foldIntoRange(f) {
      if (!f || !st.config || !window.CipherCodec) return f;
      let lo, hi;
      try {
        lo = window.CipherCodec.noteToFreq(st.config.lo_note);
        hi = window.CipherCodec.noteToFreq(st.config.hi_note);
      } catch (_) { return f; }
      const margin = Math.pow(2, 1 / 12);
      if (f >= lo / margin && f <= hi * margin) return f;
      return null;
    }
    function freqToNote(f) {
      if (!f) return null;
      const folded = foldIntoRange(f);
      if (!folded) return null;
      const raw = f; f = folded;
      const midiFloat = 69 + 12 * Math.log2(f / 440);
      const midi = Math.round(midiFloat);
      const cents = Math.round((midiFloat - midi) * 100);
      const name = NOTE_NAMES[(midi % 12 + 12) % 12] + (Math.floor(midi / 12) - 1);
      const rel = relativeRead(f);
      return { midi, cents, name, abs: name, rel, raw,
               disp: rel ? rel.note : name, dispCents: rel ? rel.cents : cents };
    }

    // ---------------------------------------------------------------- マイク
    async function start() {
      if (st.running) return true;
      try {
        st.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        st.micStream = stream;
        const src = st.audioCtx.createMediaStreamSource(stream);
        // 窓は4096（約93ms）。8192だと息を切らずに続けて吹いたときの変わり目が平均化され、
        // 2本の笛が1つに繋がる。
        st.analyser = new AnalyserNode(st.audioCtx, { fftSize: 4096, smoothingTimeConstant: 0 });
        src.connect(st.analyser);
        st.freqData = new Float32Array(st.analyser.frequencyBinCount);
        st.running = true;
        el("startBtn").style.display = "none";
        el("status").textContent = "準備完了。先頭の基準笛から順に吹いてください。";
        loop();
        return true;
      } catch (e) {
        el("startBtn").style.display = "";
        el("status").textContent = "マイクを使うには許可が必要です。「マイク開始」を押してください（初回は許可を押してください）。";
        return false;
      }
    }
    async function ensureMic() { return st.running ? true : await start(); }

    // ---------------------------------------------------------------- 続けて吹く
    function renderAutoSeq() {
      const box = el("autoSeq"); box.innerHTML = "";
      let n = 0;   // 有効なものだけに通し番号を振る。無効なものは番号を持たない
      auto.seq.forEach((s, i) => {
        const live = !s.off;
        const idx = live ? n++ : null;
        const div = document.createElement("div");
        div.className = "chip" + (idx === 0 ? " ref" : "") + (s.skipped ? " empty" : "") + (live ? "" : " off");
        div.innerHTML = `<div class="idx">${live ? (idx + 1) + (idx === 0 ? " 基準" : "") : "除外"}</div>`
          + `<div class="nm">${s.skipped ? "飛" : (s.note ? s.note.disp : "—")}`
          + `${!s.skipped && s.note && s.note.abs !== s.note.disp ? `<span class="cents"> (絶${s.note.abs})</span>` : ""}</div>`
          + `<div class="fz">${s.skipped ? "鳴らず" : (s.freq ? Math.round(s.freq) + "Hz" : "—")}`
          + `${s.durationMs ? " " + Math.round(s.durationMs) + "ms" : ""}</div>`
          + (s.why ? `<span class="why">${s.why}</span>` : "")
          + (s.warn ? `<span class="why warn">${s.warn}</span>` : "");
        div.title = "クリックで" + (live ? "この音を除外" : "この音を戻す");
        div.addEventListener("click", () => {
          auto.seq[i].off = live;
          auto.seq[i].byHand = true;      // 手で決めたものは、以後の自動判定で覆さない
          renderAutoSeq();
        });
        box.appendChild(div);
      });
    }
    /* 吹き終わったところで、テンポを手がかりに雑音を見分ける。
     * 判断は提案であって決定ではない。結果は画面に理由つきで出し、クリックで覆せる。 */
    function autoTempoPass() {
      if (!window.TempoFilter || auto.seq.length < 3) return;
      const ev = auto.seq.map(s => ({ kind: s.kind || (s.skipped ? "skip" : "note"),
                                      freq: s.freq, durationMs: s.durationMs, startMs: s.startMs }));
      const r = window.TempoFilter.analyze(ev, {});
      if (!r.beatMs) { el("autoTempo").textContent = r.note || ""; return; }
      let dropped = 0, skipped = 0;
      r.items.forEach((it, i) => {
        if (auto.seq[i].skipped) return;
        if (auto.seq[i].byHand) return;
        if (it.action === "skip") {
          // 拍には来たのに読めなかった＝笛はあったが鳴らなかった。位置を保って消失として扱う
          auto.seq[i].off = false; auto.seq[i].skipped = true;
          auto.seq[i].freq = null; auto.seq[i].note = null;
          skipped++;
        } else {
          const want = (it.action === "drop");
          if (auto.seq[i].off !== want) { auto.seq[i].off = want; if (want) dropped++; }
        }
        if (it.reason) auto.seq[i].why = it.reason;
        if (it.warn) auto.seq[i].warn = it.warn;
      });
      let inserted = 0;   // 拍の位置に音がまったく来なかったところにも、鳴らない笛として飛ばしを挿す
      if (r.missing && r.missing.length) {
        for (const m of r.missing) {
          let at = auto.seq.findIndex(s => s.startMs != null && s.startMs > m.startMs);
          if (at < 0) at = auto.seq.length;
          auto.seq.splice(at, 0, { freq: null, note: null, skipped: true, startMs: m.startMs,
                                   kind: "missing", why: m.reason });
          inserted++;
        }
      }
      const parts = [];
      if (skipped) parts.push(skipped + "本を鳴らない笛として飛ばしました");
      if (inserted) parts.push(inserted + "本ぶん、音が来なかった拍に飛ばしを入れました");
      if (dropped) parts.push(dropped + "本を雑音として除きました");
      el("autoTempo").textContent = "テンポは約" + Math.round(r.beatMs) + "ms。"
        + (parts.length ? parts.join("／") + "（クリックで戻せます）。" : "拍から外れた音はありませんでした。");
      renderAutoSeq();
    }
    function autoSetButton() {
      const b = el("autoStartBtn");
      b.textContent = auto.active ? "終了し復号" : "開始";
      b.classList.toggle("ok", auto.active);
      el("autoUndoBtn").disabled = !(auto.active && auto.seq.length);
      el("autoSkipBtn").disabled = !auto.active;
    }
    /* 鳴らない笛の位置に、どのスロットにも当てはまらない周波数を置く。復号器はそこを
     * 消失として扱い、検査用の笛で埋める。音域の1オクターブ下なら必ず範囲外になる。 */
    function skipPlaceholderFreq() {
      try {
        const lo = (st.config && st.config.lo_note) || "G#6";
        return window.CipherCodec.noteToFreq(lo) / 2;
      } catch (_) { return 100; }
    }
    function autoSkip() {
      if (!auto.active) return;
      auto.seq.push({ freq: null, note: null, skipped: true });
      renderAutoSeq(); autoSetButton();
      el("autoDot").textContent = String(auto.seq.length);
      el("autoHint").textContent = autoHintText();
      if (navigator.vibrate) navigator.vibrate([15, 40, 15]);
    }
    function autoHintText() {
      const n = auto.seq.filter(s => !s.off).length;
      return n + "本目まで入りました。続けて次の笛を吹き、終わったらボタンを押してください。";
    }
    /* 区切りの設定を画面のつまみから読む。マイクでも録音でもまったく同じ設定を使う。 */
    function autoOptions() {
      return Object.assign({}, st.segOptions, {
        gapMs: parseInt(el("gapRange").value, 10),
        pitchSplitCents: el("pitchSplit").checked ? parseInt(el("splitRange").value, 10) : 0,
        pitchStableMs: parseInt(el("stableRange").value, 10),
        minNoteMs: parseInt(el("minnoteRange").value, 10),
        endMs: Number.MAX_SAFE_INTEGER });
    }
    async function autoStart() {
      if (!await ensureMic()) { el("autoStatus").textContent = "マイクを開始できませんでした。"; return false; }
      if (rec.active) { el("autoStatus").textContent = "録音が動いています。先にそちらを終えてください。"; return false; }
      auto.seg = window.SilenceSegmenter.create(autoOptions());
      auto.active = true; auto.seq = []; auto.t0 = performance.now();
      st.refMeasuredHz = null;
      el("autoStatus").textContent = ""; el("autoTempo").textContent = "";
      el("autoDot").classList.add("prep"); el("autoDot").textContent = "測定";
      el("autoHint").textContent = "部屋の静けさを測っています。少しだけ静かにしてください。";
      onReset();
      autoSetButton(); renderAutoSeq();
      return true;
    }
    function autoStop() {
      auto.active = false;
      el("autoDot").classList.remove("on", "prep"); el("autoDot").textContent = "–";
      el("autoLevel").style.width = "0%";
      autoSetButton();
    }
    /* 吹き終わり。テンポで雑音と鳴らなかった笛を見分け、周波数の列をページへ渡す。 */
    function autoEnd() {
      autoStop();
      if (!auto.seq.length) { el("autoStatus").textContent = "1本も入っていません。"; return; }
      autoTempoPass();
      finishSequence("続けて吹く");
    }
    function finishSequence(how) {
      const ph = skipPlaceholderFreq();
      const live = auto.seq.filter(s => !s.off);
      const skipped = live.filter(s => s.skipped).length;
      const dropped = auto.seq.length - live.length;
      const freqs = live.map(s => s.skipped ? ph : s.freq);
      el("autoStatus").textContent = live.length + "本を記録しました"
        + (dropped ? "（" + dropped + "本は雑音として除きました）" : "")
        + (skipped ? "（うち" + skipped + "本は鳴らないものとして空けました）" : "") + "。";
      onSequence(freqs, { how, count: live.length, skipped, dropped });
    }
    function autoToggle() { auto.active ? autoEnd() : autoStart(); }
    function autoUndo() {   // 咳や物音が1本として入ってしまったときに使う
      if (!auto.seq.length) return;
      auto.seq.pop();
      renderAutoSeq(); autoSetButton();
      el("autoDot").textContent = auto.seq.length ? String(auto.seq.length) : "待機";
      el("autoHint").textContent = auto.seq.length
        ? "直前の1本を取り消しました。いまは" + auto.seq.length + "本です。"
        : "すべて取り消しました。1本目から吹いてください。";
      if (navigator.vibrate) navigator.vibrate(15);
    }
    function autoClear() {
      autoStop();
      auto.seq = []; auto.seg = null;
      el("autoStatus").textContent = ""; el("autoTempo").textContent = "";
      el("autoHint").textContent = "開始すると、まず部屋の静けさを0.4秒ほど測り、そこを基準に区切りを判定します。";
      autoSetButton(); renderAutoSeq();
      onReset();
    }

    // ---------------------------------------------------------------- 録音を読む
    /* 録音を1つ解析して、読み取った音を列の末尾へ足す。時刻は tOffset だけずらす。 */
    async function readOneRecording(file, tOffset) {
      const buf = await file.arrayBuffer();
      const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
      const audio = await ctx.decodeAudioData(buf);
      const sr = audio.sampleRate;
      const x = audio.getChannelData(0);
      const WIN = 4096, HOP = Math.round(sr * 0.011);
      const tr = window.FftPeak.track(x, sr, { loHz: st.loFloorHz, hiHz: st.hiCeilHz, win: WIN, hop: HOP });
      // 暗騒音は録音全体の分布の静かな側1割で決める（冒頭が無音とは限らないため）
      const noiseDb = window.FftPeak.noiseFloorDb(tr.levels, 10);
      const opts = Object.assign(autoOptions(), {
        noiseDb: noiseDb,
        onMarginDb: st.segOptions.onMarginDb !== undefined ? st.segOptions.onMarginDb : 18 });
      const seg = window.SilenceSegmenter.create(opts);
      const before = auto.seq.length;
      for (let i = 0; i < tr.times.length; i++) {
        const t = tr.times[i], db = tr.levels[i], f = tr.freqs[i];
        const ev = seg.feed(t, db, f);
        if (ev.type === "note") {
          const nt = ev.freq ? freqToNote(ev.freq) : null;
          if (ev.freq && !nt) {
            auto.seq.push({ freq: ev.freq, note: null, kind: "reject", off: true,
                            why: "符号の音域から外れた（" + Math.round(ev.freq) + "Hz）",
                            durationMs: ev.durationMs, startMs: ev.startMs + tOffset });
            continue;
          }
          if (ev.freq && auto.seq.length === 0) st.refMeasuredHz = ev.freq;
          auto.seq.push({ freq: ev.freq, note: nt, kind: "note",
                          durationMs: ev.durationMs, startMs: ev.startMs + tOffset });
        } else if (ev.type === "reject" && (ev.freq || ev.durationMs)) {
          auto.seq.push({ freq: ev.freq || null, note: ev.freq ? freqToNote(ev.freq) : null,
                          kind: "reject", off: true, why: ev.reason || "短すぎた",
                          durationMs: ev.durationMs, startMs: ev.startMs + tOffset });
        }
      }
      return { name: file.name, durationMs: audio.duration * 1000, noiseDb, onDb: seg.thresholds().onDb,
               count: auto.seq.slice(before).filter(s => !s.off).length };
    }
    /* 録音を吹いた順に続けて読む。録音ごとに暗騒音を測り直し、時刻だけを通しの軸に並べる。 */
    async function readRecordings(files, statusEl) {
      const st_ = statusEl || el("autoStatus");
      st_.textContent = "読み取っています…";
      try {
        auto.seq = []; st.refMeasuredHz = null;
        onReset();
        const infos = [];
        let tOffset = 0;
        for (const file of files) {
          const info = await readOneRecording(file, tOffset);
          infos.push(info);
          tOffset += info.durationMs + CARRIER_GAP_MS;
        }
        const total = auto.seq.filter(s => !s.off).length;
        st_.textContent = total + "本を読み取りました（音域 " + Math.round(st.loFloorHz) + "〜" + Math.round(st.hiCeilHz)
          + "Hz、暗騒音 " + infos.map(v => v.noiseDb.toFixed(1)).join("・") + "dB）。";
        renderAutoSeq();
        autoTempoPass();
        finishSequence("録音");
      } catch (e) {
        st_.textContent = "読み込めませんでした（" + e.message + "）。";
      }
    }

    // ---------------------------------------------------------------- その場で録音する入口
    /* 吹いている最中は何も判定せず、録音するだけにする。1本ごとに判定して見せると、
     * 鳴らない笛に気づいて吹き直したところで拍が崩れ、あとから穴を埋められなくなる。
     * 止まらずに吹けば、拍を手がかりに飛ばしが入り、誤り訂正で埋まる。 */
    function recSetBeat() { el("recBeatVal").textContent = el("recBeat").value + " ms"; }
    async function recStart() {
      if (!await ensureMic()) { el("recStatus").textContent = "マイクを開始できませんでした。"; return; }
      if (!st.micStream) { el("recStatus").textContent = "マイクの流れを取れませんでした。"; return; }
      if (auto.active) { el("recStatus").textContent = "「続けて吹く」が動いています。先にそちらを終えてください。"; return; }
      if (typeof MediaRecorder === "undefined") {
        el("recStatus").textContent = "このブラウザは録音に対応していません。"; return;
      }
      rec.chunks = [];
      const cand = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", ""];
      const type = cand.find(t => t === "" || (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)));
      try {
        rec.mr = type ? new MediaRecorder(st.micStream, { mimeType: type }) : new MediaRecorder(st.micStream);
      } catch (e) {
        el("recStatus").textContent = "録音を始められませんでした（" + e.message + "）。"; return;
      }
      rec.mr.ondataavailable = e => { if (e.data && e.data.size) rec.chunks.push(e.data); };
      rec.mr.onstop = recFinish;
      rec.mr.start();
      rec.active = true; rec.t0 = performance.now(); rec.beats = 0;
      el("recStartBtn").textContent = "終わり（読み取る）";
      el("recStatus").textContent = "録音しています。拍に合わせて、止まらずに吹いてください。";
      onReset();
      const tick = () => {     // 拍の印。音は鳴らさない（マイクが拾ってしまうため）
        if (!rec.active) return;
        rec.beats++;
        el("recDot").classList.toggle("on");
        el("recDot").textContent = String(rec.beats);
        el("recCount").textContent = rec.beats + "拍め（" + ((performance.now() - rec.t0) / 1000).toFixed(1) + "秒）。"
          + "鳴らない笛は1拍ぶん空けて次へ。持ち替えは3秒以上ゆっくり。";
      };
      rec.timer = setInterval(tick, parseInt(el("recBeat").value, 10));
      tick();
    }
    function recStop() {
      if (!rec.active) return;
      rec.active = false;
      clearInterval(rec.timer); rec.timer = null;
      el("recDot").classList.remove("on"); el("recDot").textContent = "–";
      el("recStartBtn").textContent = "録音を開始して吹く";
      el("recStatus").textContent = "読み取っています…";
      try { rec.mr.stop(); } catch (e) { el("recStatus").textContent = "止められませんでした（" + e.message + "）。"; }
    }
    async function recFinish() {
      const blob = new Blob(rec.chunks, { type: rec.mr && rec.mr.mimeType || "audio/webm" });
      if (!blob.size) { el("recStatus").textContent = "録音が空でした。もう一度お試しください。"; return; }
      const ext = /mp4/.test(blob.type) ? "m4a" : (/ogg/.test(blob.type) ? "ogg" : "webm");
      const file = new File([blob], "その場の録音." + ext, { type: blob.type });
      await readRecordings([file], el("recStatus"));
      el("recCount").textContent = "もう一度録るときは「録音を開始して吹く」を押してください。";
    }
    function recToggle() { rec.active ? recStop() : recStart(); }

    // ---------------------------------------------------------------- 解析の輪
    function loop() {
      st.analyser.getFloatFrequencyData(st.freqData);
      const binHz = st.audioCtx.sampleRate / st.analyser.fftSize;
      const pk = window.FftPeak.peakInBand(st.freqData, binHz, st.loFloorHz, st.hiCeilHz);
      st.live.freq = (pk && pk.level > MIC_ON_DB) ? pk.freq : 0;
      st.live.bandDb = pk ? pk.level : -120;

      const info = st.live.freq ? freqToNote(st.live.freq) : null;
      el("hz").textContent = st.live.freq ? st.live.freq.toFixed(1) : "–";
      el("noteName").textContent = info ? info.disp : "–";
      el("cents").textContent = info ? (info.cents >= 0 ? "+" : "") + info.cents + " c" : "";
      el("clarBar").style.width = Math.max(0, Math.min(100, (st.live.bandDb - MIC_ON_DB) * 2.5)) + "%";

      if (auto.active) {
        const t = performance.now() - auto.t0;
        const ev = auto.seg.feed(t, st.live.bandDb, st.live.freq);
        el("autoLevel").style.width = Math.max(0, Math.min(100, (st.live.bandDb + 100) / 0.7)) + "%";
        if (ev.type === "calibrating") {
          el("autoDot").textContent = "測定";
        } else if (ev.type === "onset") {
          el("autoDot").classList.remove("prep"); el("autoDot").classList.add("on");
          el("autoDot").textContent = String(auto.seq.length + 1);
        } else if (ev.type === "sounding") {
          el("autoDot").classList.add("on");
        } else if (ev.type === "note") {
          el("autoDot").classList.remove("on");
          const nt = ev.freq ? freqToNote(ev.freq) : null;
          if (ev.freq && !nt) {
            // 音域の外。列から消さず、読めなかった印を付けて残す。
            // ★ここで return してはいけない★ 末尾の次フレーム予約へ到達せず画面が止まる。
            auto.seq.push({ freq: ev.freq, note: null, kind: "reject", off: true,
                            why: "符号の音域から外れた（" + Math.round(ev.freq) + "Hz）",
                            durationMs: ev.durationMs, startMs: ev.startMs });
            renderAutoSeq();
            el("autoHint").textContent = "符号の音域から外れた音（" + Math.round(ev.freq)
              + "Hz）だったので数えませんでした。そのまま次の笛を吹いてください。";
            el("autoDot").textContent = String(auto.seq.length);
          } else {
            if (ev.freq && auto.seq.length === 0) st.refMeasuredHz = ev.freq;   // 1本目＝基準笛
            auto.seq.push({ freq: ev.freq, note: nt, kind: "note", durationMs: ev.durationMs, startMs: ev.startMs });
            renderAutoSeq(); autoSetButton();
            el("autoDot").textContent = String(auto.seq.length);
            el("autoHint").textContent = autoHintText();
            if (navigator.vibrate) navigator.vibrate(25);
          }
        } else if (ev.type === "reject") {
          if (ev.freq || ev.durationMs) {
            auto.seq.push({ freq: ev.freq || null, note: ev.freq ? freqToNote(ev.freq) : null,
                            kind: "reject", off: true, why: ev.reason || "短すぎた",
                            durationMs: ev.durationMs, startMs: ev.startMs });
            renderAutoSeq();
          }
          el("autoDot").classList.remove("on");
          el("autoHint").textContent = "短すぎる音は雑音として捨てました。もう少し長めに吹いてください。";
        } else if (ev.type === "idle") {
          el("autoDot").classList.remove("prep", "on");
          if (auto.seq.length === 0) {
            el("autoDot").textContent = "待機";
            const th = auto.seg.thresholds();
            el("autoHint").textContent = "準備できました。1本目を吹いてください（区切りの基準は " + Math.round(th.onDb) + " dB）。";
          }
        }
      }
      requestAnimationFrame(loop);
    }

    // ---------------------------------------------------------------- 復号と照合
    function b64urlToBytes(s) {
      s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
      const bin = atob(s); const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    async function aesKey(canonical) {
      const keyRaw = await crypto.subtle.digest("SHA-256", canonical);
      return crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["decrypt"]);
    }
    /* c= の中身を、笛の秘密を鍵にして取り出す。AES-GCMは改ざんも検出するので、
     * 取り出せたこと自体が「正しい秘密を吹いた」証拠になる。 */
    async function decryptPack(canonical) {
      try {
        const key = await aesKey(canonical);
        const blob = b64urlToBytes(st.packEnc);
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) }, key, blob.slice(12));
        const obj = JSON.parse(new TextDecoder().decode(pt));
        return (obj && typeof obj === "object") ? obj : null;
      } catch (_) { return null; }
    }
    async function decryptGoto(canonical) {
      try {
        const key = await aesKey(canonical);
        const blob = b64urlToBytes(st.gotoEnc);
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) }, key, blob.slice(12));
        const url = new TextDecoder().decode(pt);
        return /^https?:\/\//i.test(url) ? url : "";
      } catch (_) { return ""; }
    }
    function escapeHtml(s) { return s.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }
    /* 認証成功の表示。画面全体を覆うので、その中にも進む手段を出しておく。 */
    function showSuccess(url) {
      el("successGo").href = url; el("successGo").style.display = "";
      el("successSub").textContent = "秘密のページへ移動します…";
      el("successOverlay").classList.add("show");
      setTimeout(() => {
        if (el("successOverlay").classList.contains("show")) location.assign(url);
      }, 3000);
    }
    function showOverlay(sub) {
      el("successSub").textContent = sub;
      el("successGo").style.display = "none";
      el("successOverlay").classList.add("show");
    }
    function expectedSha() {
      return (has("cipherHash") ? el("cipherHash").value : st.sha256).trim().toLowerCase();
    }
    function hasAuth() { return !!(st.packEnc || st.gotoEnc || expectedSha()); }
    /* 取り出した秘密（canonical）を照合し、結果を verdictId の要素へ書く。
     * 成功なら遷移（または言葉の表示）まで行う。戻り値は成功かどうか。 */
    async function verifyCanonical(canonical, verdictId) {
      const out = t => { el(verdictId).innerHTML = t; };
      if (st.packEnc) {
        const pack = await decryptPack(canonical);
        if (!pack) { out('<span class="ngmark">中身を取り出せません（秘密が違います）</span>'); return false; }
        const msg = (typeof pack.msg === "string") ? pack.msg : "";
        out('<span class="okmark">認証成功（秘密で設定を取り出しました）</span>'
          + (msg ? ' <span class="muted">' + escapeHtml(msg) + '</span>' : ""));
        if (typeof pack.goto === "string" && /^https?:\/\//i.test(pack.goto)) showSuccess(pack.goto);
        else if (msg) showOverlay(msg);
        return true;
      }
      if (st.gotoEnc) {
        const url = await decryptGoto(canonical);
        if (url) { out('<span class="okmark">認証成功（秘密で遷移先を復号）</span>'); showSuccess(url); return true; }
        out('<span class="ngmark">遷移先を復号できません（秘密が違います）</span>');
        return false;
      }
      const expected = expectedSha();
      if (!expected) { out('<span class="muted">照合用の値は指定されていません</span>'); return false; }
      if (!/^[0-9a-f]{64}$/.test(expected)) { out('<span class="ngmark">SHA-256は64桁hexで入力してください</span>'); return false; }
      const digest = await crypto.subtle.digest("SHA-256", canonical);
      const actual = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, "0")).join("");
      const ok = actual === expected;
      out(ok ? '<span class="okmark">SHA-256 OK（一致）</span>' : '<span class="ngmark">SHA-256 NG（不一致）</span>');
      if (ok && st.gotoUrl) showSuccess(st.gotoUrl);
      return ok;
    }
    function decode(freqs) { return window.CipherCodec.decode(freqs, st.config, true); }
    /* 復号結果から、照合と鍵に使う正規形（記号の列、または payload のバイト列）を作る */
    function canonicalOf(result) {
      return (st.config.mode === "symbols") ? Uint8Array.from(result.symbols || []) : result.payload;
    }

    // ---------------------------------------------------------------- 配線
    el("autoStartBtn").onclick = autoToggle;
    el("autoSkipBtn").onclick = autoSkip;
    el("autoUndoBtn").onclick = autoUndo;
    el("autoClearBtn").onclick = autoClear;
    el("startBtn").onclick = start;
    el("successClose").onclick = () => { el("successOverlay").classList.remove("show"); };
    // つまみは、吹いている最中に動かしてもその場で効く
    el("gapRange").oninput = () => {
      const v = parseInt(el("gapRange").value, 10);
      el("gapVal").textContent = v + " ms";
      if (auto.seg) auto.seg.options.gapMs = v;
    };
    el("splitRange").oninput = () => {
      const v = parseInt(el("splitRange").value, 10);
      el("splitVal").textContent = v + " セント";
      if (auto.seg && el("pitchSplit").checked) auto.seg.options.pitchSplitCents = v;
    };
    el("stableRange").oninput = () => {
      const v = parseInt(el("stableRange").value, 10);
      el("stableVal").textContent = v + " ms";
      if (auto.seg) auto.seg.options.pitchStableMs = v;
    };
    el("minnoteRange").oninput = () => {
      const v = parseInt(el("minnoteRange").value, 10);
      el("minnoteVal").textContent = v + " ms";
      if (auto.seg) auto.seg.options.minNoteMs = v;
    };
    el("pitchSplit").onchange = () => {
      if (auto.seg) auto.seg.options.pitchSplitCents = el("pitchSplit").checked ? parseInt(el("splitRange").value, 10) : 0;
    };
    if (has("recStartBtn")) {
      el("recStartBtn").onclick = recToggle;
      el("recBeat").oninput = recSetBeat;
      recSetBeat();
    }
    autoSetButton(); renderAutoSeq();
    start();   // ページを開いたら自動でマイク開始を試みる（拒否されたらボタン操作で開始）

    return {
      configReady, state: st,
      start, autoStart, autoEnd, autoStop, autoClear, readRecordings,
      decode, canonicalOf, verifyCanonical, hasAuth, showSuccess, showOverlay, freqToNote,
      get config() { return st.config; },
      get sequenceCount() { return auto.seq.filter(s => !s.off).length; },
    };
  }

  window.CipherReader = { create };
})();
