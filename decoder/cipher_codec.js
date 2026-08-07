/* CipherFlute復号器。fue/cipher_codec.pyと同じ計算を依存なしで行う。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CipherCodec = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  function noteToMidi(note) {
    const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(note).trim());
    if (!match) throw new Error("bad note: " + JSON.stringify(note));
    const base = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11}[match[1].toUpperCase()];
    const accidental = {"": 0, "#": 1, b: -1}[match[2]];
    return base + accidental + 12 * (Number(match[3]) + 1);
  }

  function midiToNote(midi) {
    return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  function noteToFreq(note) {
    return 440 * Math.pow(2, (noteToMidi(note) - 69) / 12);
  }

  function validateConfig(cfg) {
    if (!(cfg.step_cents > 0) || cfg.ecc_parity < 0) throw new Error("ステップは正、パリティは0以上が必要");
    const lo = noteToMidi(cfg.lo_note) * 100;
    const hi = noteToMidi(cfg.hi_note) * 100;
    const ref = noteToMidi(cfg.reference_note) * 100;
    const span = (hi - lo) / cfg.step_cents;
    const q = (ref - lo) / cfg.step_cents;
    if (hi < lo || Math.abs(span - Math.round(span)) > 1e-9) throw new Error("音域がスロット間隔で割り切れない");
    if (Math.abs(q - Math.round(q)) > 1e-9) throw new Error("reference_noteがスロット格子上にない");  // 基準は音域(lo..hi)の外でもよい（比読みの基準としてのみ使う）
    if (cfg.mode !== "sequential" && cfg.mode !== "symbols") throw new Error("未対応のmode");
    // 差分写像は直前の音を起点にする。1本目の起点は基準笛しかない。
    if (cfg.no_repeat && cfg.use_reference === false) throw new Error("no_repeatには基準笛(use_reference=True)が必要");
  }

  function slots(cfg) {
    validateConfig(cfg);
    const lo = noteToMidi(cfg.lo_note);
    const count = Math.round((noteToMidi(cfg.hi_note) - lo) * 100 / cfg.step_cents);
    const f0 = noteToFreq(cfg.lo_note);
    const table = [];
    for (let i = 0; i <= count; i++) {
      table.push({
        index: i,
        cents_from_lo: i * cfg.step_cents,
        freq_hz: f0 * Math.pow(2, i * cfg.step_cents / 1200),
        nearest_note: midiToNote(Math.round(lo + i * cfg.step_cents / 100))
      });
    }
    table.m = table.length;
    table.reference_index = refSlotIndex(cfg);
    return table;
  }

  function refSlotIndex(cfg) {
    return Math.round((noteToMidi(cfg.reference_note) - noteToMidi(cfg.lo_note)) * 100 / cfg.step_cents);
  }

  function _prime(n) {
    while (n < 2 || Array.from({length: Math.max(0, Math.floor(Math.sqrt(n)) - 1)}, (_, i) => i + 2).some(d => n % d === 0)) n++;
    return n;
  }

  function _primeBelow(n) {
    /* n以下の最大素数を返す。 */
    const composite = k => Array.from({length: Math.max(0, Math.floor(Math.sqrt(k)) - 1)}, (_, i) => i + 2).some(d => k % d === 0);
    while (n >= 2 && composite(n)) n--;
    if (n < 2) throw new Error("素数体が取れない(スロットが少なすぎる)");
    return n;
  }

  function _wireParams(cfg, m) {
    /* {m, mb, wb, p, w} を返す。Python版の_wire_paramsと同じ規則。
       no_repeat=Trueでは差分値が0..m-2のm-1通りしかないので、笛1本=記号1個を
       保つためpをm-1以下の最大素数に取る(m=11ならp=7)。 */
    if (!cfg.no_repeat) {
      const p = _prime(m);
      return {m: m, mb: m, wb: m, p: p, w: _width(m, p)};
    }
    const p = _primeBelow(m - 1);
    return {m: m, mb: p, wb: m - 1, p: p, w: 1};
  }

  function _diffDecode(seq, m, start) {
    /* スロット列を差分値の列へ戻す。s_i = (s_{i-1} + 1 + d_i) mod m の逆。 */
    const out = [];
    let prev = mod(start, m);
    for (const s of seq) { out.push(mod(s - prev - 1, m)); prev = s; }
    return out;
  }

  function _interleaveOrder(sizes) {
    /* 送出順t → ブロック連結順の位置。列ごとに各ブロックから1記号ずつ拾う。
       ブロックが1個しかない短い秘密では混ぜようがなく素通りする。 */
    const offsets = [];
    let at = 0;
    for (const size of sizes) { offsets.push(at); at += size; }
    const order = [], maxSize = sizes.length ? Math.max(...sizes) : 0;
    for (let i = 0; i < maxSize; i++) {
      sizes.forEach((size, b) => { if (i < size) order.push(offsets[b] + i); });
    }
    return order;
  }

  function _blockLayout(total, parity, blockData) {
    /* 受信記号数から各RSブロックの符号語長を復元する。 */
    if (total <= 0) return [];
    for (let k = 1; k <= total; k++) {
      const data = total - k * parity;
      if (data < k) break;
      if (Math.ceil(data / blockData) === k) {
        return Array.from({length: k}, (_, j) => Math.floor(data / k) + parity + (j < data % k ? 1 : 0));
      }
    }
    throw new Error("ブロック構成が不正");
  }

  function _toBase(value, base, width) {
    value = typeof value === "bigint" ? value : BigInt(value);
    const b = BigInt(base);
    if (value < 0n || base < 2) throw new Error("不正な値または底");
    const out = value === 0n ? [0] : [];
    while (value) {
      out.push(Number(value % b));
      value /= b;
    }
    out.reverse();
    if (width !== undefined) {
      if (out.length > width) throw new Error("指定幅に収まらない");
      while (out.length < width) out.unshift(0);
    }
    return out;
  }

  function _fromBase(digits, base) {
    let value = 0n;
    for (const d of digits) {
      if (!(0 <= d && d < base)) throw new Error("数字が範囲外");
      value = value * BigInt(base) + BigInt(d);
    }
    return value;
  }

  function mod(x, p) { return ((x % p) + p) % p; }
  function modPow(base, exponent, p) {
    let out = 1;
    base = mod(base, p);
    while (exponent > 0) {
      if (exponent % 2) out = mod(out * base, p);
      base = mod(base * base, p);
      exponent = Math.floor(exponent / 2);
    }
    return out;
  }

  function _root(p) {
    /* GF(p)の原始元(最小の原始根)。位数がp-1でないとRSの誤り位置が一意に定まらない。
       p=11,13では2なので従来の符号語は変わらない。 */
    if (_root.cache.has(p)) return _root.cache.get(p);
    let out = 1;
    for (let g = 2; g < p; g++) {
      const seen = new Set();
      for (let k = 1; k < p; k++) seen.add(modPow(g, k, p));
      if (seen.size === p - 1) { out = g; break; }
    }
    _root.cache.set(p, out);
    return out;
  }
  _root.cache = new Map();

  function _generator(nsym, p) {
    let g = [1];
    for (let r = 1; r <= nsym; r++) {
      const a = modPow(_root(p), r, p), next = Array(g.length + 1).fill(0);
      g.forEach((c, i) => {
        next[i] = mod(next[i] + c, p);
        next[i + 1] = mod(next[i + 1] - c * a, p);
      });
      g = next;
    }
    return g;
  }

  function _rsEncode(message, nsym, p) {
    if (!nsym) return message.slice();
    if (message.length + nsym > p - 1) throw new Error("RS符号長がp-1を超える");
    const g = _generator(nsym, p), work = message.concat(Array(nsym).fill(0));
    for (let i = 0; i < message.length; i++) {
      const c = work[i];
      g.forEach((x, j) => { work[i + j] = mod(work[i + j] - c * x, p); });
    }
    return message.concat(work.slice(-nsym).map(x => mod(-x, p)));
  }

  function _syndromes(word, nsym, p) {
    return Array.from({length: nsym}, (_, k) => {
      const r = k + 1, a = modPow(_root(p), r, p), n = word.length;
      return mod(word.reduce((sum, v, i) => sum + v * modPow(a, n - 1 - i, p), 0), p);
    });
  }

  function _solve(a, b, p) {
    const n = b.length;
    const z = a.map((row, i) => row.map(x => mod(x, p)).concat(mod(b[i], p)));
    for (let c = 0; c < n; c++) {
      const pivot = z.findIndex((row, r) => r >= c && row[c] !== 0);
      if (pivot < 0) return null;
      [z[c], z[pivot]] = [z[pivot], z[c]];
      const inv = modPow(z[c][c], p - 2, p);
      z[c] = z[c].map(x => mod(x * inv, p));
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const q = z[r][c];
        z[r] = z[r].map((x, i) => mod(x - q * z[c][i], p));
      }
    }
    return z.map((row, i) => row[n]);
  }

  function combinations(values, count) {
    if (count === 0) return [[]];
    const out = [];
    function visit(start, chosen) {
      if (chosen.length === count) { out.push(chosen.slice()); return; }
      for (let i = start; i <= values.length - (count - chosen.length); i++) {
        chosen.push(values[i]); visit(i + 1, chosen); chosen.pop();
      }
    }
    visit(0, []);
    return out;
  }

  function _rsDecode(received, nsym, p, erasures) {
    const erased = new Set(erasures || []), syn = _syndromes(received, nsym, p);
    if (!syn.some(Boolean) && !erased.size) return [received.slice(), new Set()];
    const candidates = received.map((_, i) => i).filter(i => !erased.has(i));
    const maxExtra = Math.floor((nsym - erased.size) / 2);
    for (let count = 0; count <= maxExtra; count++) {
      for (const extra of combinations(candidates, count)) {
        const pos = Array.from(new Set([...erased, ...extra])).sort((a, b) => a - b);
        if (!pos.length) continue;
        const a = pos.map((_, row) => {
          const r = row + 1, alpha = modPow(_root(p), r, p);
          return pos.map(i => modPow(alpha, received.length - 1 - i, p));
        });
        const mag = _solve(a, syn.slice(0, pos.length).map(x => mod(-x, p)), p);
        if (!mag) continue;
        const trial = received.slice();
        pos.forEach((at, i) => { trial[at] = mod(trial[at] + mag[i], p); });
        if (!_syndromes(trial, nsym, p).some(Boolean)) return [trial, new Set(pos)];
      }
    }
    throw new Error("RSで訂正できない");
  }

  function _width(m, p) {
    let w = 1, cap = m;
    while (cap < p) { w++; cap *= m; }
    return w;
  }

  function _payloadWidth(nbytes, m) {
    /* Bバイトを表すのに必要な最小のbase-m固定幅d (m**d >= 256**B)。 */
    if (nbytes < 0) throw new Error("バイト数が負");
    let width = 0, cap = 1n;
    const target = 256n ** BigInt(nbytes), base = BigInt(m);
    while (cap < target) { width++; cap *= base; }
    return width;
  }

  function _widthToBytes(width, m) {
    /* データ記号数dから唯一のバイト数Bを逆算する(d→Bは一対一)。 */
    let nbytes = 0;
    while (_payloadWidth(nbytes, m) < width) nbytes++;
    if (_payloadWidth(nbytes, m) !== width) throw new Error("データ記号数が不正");
    return nbytes;
  }

  function bigintToBytes(value, size) {
    if (value < 0n) throw new Error("整数が負");
    const out = new Uint8Array(size);
    for (let i = size - 1; i >= 0; i--) { out[i] = Number(value & 255n); value >>= 8n; }
    if (value) throw new Error("int too big to convert");
    return out;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
  }

  function decode(measuredFreqs, cfg, positionsKnown) {
    positionsKnown = positionsKnown === undefined ? true : positionsKnown;
    if (!Array.isArray(measuredFreqs) || !measuredFreqs.length || measuredFreqs.some(f => !(f > 0))) {
      return {payload: new Uint8Array(), payloadHex: "", decisions: [], status: "error: 正の周波数が必要", symbols: [], correctedCount: 0, erasureCount: 0};
    }
    let table;
    try { table = slots(cfg); } catch (e) {
      return {payload: new Uint8Array(), payloadHex: "", decisions: [], status: "error: " + e.message, symbols: [], correctedCount: 0, erasureCount: 0};
    }
    const useRef = cfg.use_reference !== false;   // 既定は基準笛あり
    let data, resid;
    if (useRef) {
      // 先頭(または基準音に最も近い笛)を基準に、周波数比で温度・吹圧を打ち消す
      const refNominal = noteToFreq(cfg.reference_note);   // 基準の公称周波数（データ音域の外でもよい）
      let rp = 0;
      if (!positionsKnown) {
        rp = measuredFreqs.reduce((best, f, i) =>
          Math.abs(1200 * Math.log2(f / refNominal)) < Math.abs(1200 * Math.log2(measuredFreqs[best] / refNominal)) ? i : best, 0);
      }
      const ref = measuredFreqs[rp];
      data = measuredFreqs.slice(0, rp).concat(measuredFreqs.slice(rp + 1));
      const ratios = table.map(s => s.freq_hz / refNominal);
      resid = f => ratios.map(x => 1200 * Math.log2((f / ref) / x));
    } else {
      // 基準笛なし＝全笛データ。絶対音程で丸める(温度・吹圧補正なし)
      data = measuredFreqs.slice();
      resid = f => table.map(s => 1200 * Math.log2(f / s.freq_hz));
    }
    const guard = cfg.decision_guard_cents == null ? cfg.step_cents / 2 : cfg.decision_guard_cents;
    const decisions = [], wire = [], erased = new Set();
    data.forEach((f, j) => {
      const residuals = resid(f);
      let index = 0;
      for (let i = 1; i < residuals.length; i++) if (Math.abs(residuals[i]) < Math.abs(residuals[index])) index = i;
      const bad = Math.abs(residuals[index]) > guard;
      decisions.push({slotIndex: index, slot_index: index, residualCents: residuals[index], residual_cents: residuals[index], isErasure: bad, is_erasure: bad, corrected: false});
      wire.push(index);
      if (bad) erased.add(j);
    });
    const {m, mb, wb, p, w} = _wireParams(cfg, table.length);
    try {
      let digits = wire, suspect = erased;
      if (cfg.no_repeat) {
        // 差分の逆写像。起点は基準笛の公称スロット。
        digits = _diffDecode(wire, m, refSlotIndex(cfg));
        // 1本の読み違いは差分2個を汚すので、消失は次の記号へも波及させる。
        suspect = new Set(erased);
        erased.forEach(j => { if (j + 1 < digits.length) suspect.add(j + 1); });
      }
      if (digits.length % w) throw new Error("記号数が不正");
      const received = [], erasures = new Set();
      for (let start = 0; start < digits.length; start += w) {
        const chunk = digits.slice(start, start + w);
        const pos = start / w;
        // 差分がm-1(=隣と同じ音)は符号化では起こり得ない。読み違いの印として消失にする。
        const invalid = chunk.some(d => d >= wb);
        let value = invalid ? 0 : Number(_fromBase(chunk, wb));
        if (invalid || value >= p || Array.from({length: w}, (_, i) => start + i).some(i => suspect.has(i))) {
          erasures.add(pos); value %= p;
        }
        received.push(value);
      }
      let sizes, order;
      if (cfg.no_repeat) {
        sizes = _blockLayout(received.length, cfg.ecc_parity, (p - 1) - cfg.ecc_parity);
        order = _interleaveOrder(sizes);
      } else {
        sizes = [];
        for (let s = 0; s < received.length; s += p - 1) sizes.push(Math.min(p - 1, received.length - s));
        order = received.map((_, i) => i);
      }
      // 送出順(=笛の並び)をブロック連結順へ戻す。
      const blockMajor = new Array(received.length).fill(0), blockErased = new Set();
      order.forEach((g, t) => { blockMajor[g] = received[t]; if (erasures.has(t)) blockErased.add(g); });
      const changed = new Set(), msg = [];
      let at = 0;
      for (const size of sizes) {
        const block = blockMajor.slice(at, at + size);
        if (block.length < cfg.ecc_parity + 1) throw new Error("RSブロック長が不正");
        const start = at;
        const blockErasures = new Set(Array.from(blockErased).filter(pos => start <= pos && pos < start + size).map(pos => pos - start));
        const [decoded, blockChanged] = _rsDecode(block, cfg.ecc_parity, p, blockErasures);
        blockChanged.forEach(pos => changed.add(start + pos));
        msg.push(...decoded.slice(0, size - cfg.ecc_parity));
        at += size;
      }
      let payload, outSymbols;
      if (cfg.mode === "symbols") {
        payload = new Uint8Array(); outSymbols = msg;
      } else {
        const size = _widthToBytes(msg.length, mb);
        payload = bigintToBytes(_fromBase(msg, mb), size);
        outSymbols = wire;
      }
      const inverse = new Map(order.map((g, t) => [g, t]));
      changed.forEach(pos => {
        const t = inverse.get(pos);
        for (let j = t * w; j < Math.min((t + 1) * w, decisions.length); j++) decisions[j].corrected = true;
      });
      return {payload, payloadHex: bytesToHex(payload), decisions, status: changed.size ? "corrected" : "ok", symbols: outSymbols, correctedCount: changed.size, erasureCount: erasures.size};
    } catch (e) {
      return {payload: new Uint8Array(), payloadHex: "", decisions, status: "error: " + e.message, symbols: wire, correctedCount: 0, erasureCount: erased.size};
    }
  }

  function combineShares(lists, base) {
    /* 2-of-2 の断片を足し合わせて秘密を戻す。
       各断片は同じ桁数の base 進の記号列である。片方は乱数、もう片方は
       「秘密−乱数」なので、足して base^桁数 で割った余りが秘密になる。
       戻り値は {value, digits}。digits は秘密を同じ桁数で表した記号列である。 */
    if (!Array.isArray(lists) || lists.length < 2) throw new Error("断片が2つ必要です");
    const n = lists[0].length;
    lists.forEach(function (d) {
      if (d.length !== n) throw new Error("断片の記号数が違います");
      d.forEach(function (s) {
        if (!(Number.isInteger(s) && s >= 0 && s < base)) throw new Error("記号が範囲外です");
      });
    });
    const span = BigInt(base) ** BigInt(n);          // 桁が多くても正しく扱えるようBigIntで計算する
    const total = lists.reduce(function (sum, d) {
      return (sum + _fromBase(d, base)) % span;
    }, 0n);
    return {value: Number(total) <= Number.MAX_SAFE_INTEGER ? Number(total) : total,
            digits: _toBase(total, base, n)};
  }

  function _invMod(a, p) {
    /* GF(p) での逆数（pは素数）。フェルマーの小定理で a^(p-2) を求める。 */
    let base = ((a % p) + p) % p;
    if (base === 0) throw new Error("0の逆数は無い");
    let result = 1, exp = p - 2;
    while (exp > 0) {
      if (exp & 1) result = (result * base) % p;
      base = (base * base) % p;
      exp >>= 1;
    }
    return result;
  }

  function combineThreshold(shares, base) {
    /* しきい値秘密分散（Shamir）の断片から秘密を戻す。
       shares は [{x: 断片の番号, symbols: 記号列}, ...] で、必要な数以上あればよい。
       ラグランジュ補間を x=0 で評価する（多項式の定数項が秘密である）。
       Python版 fue/threshold.py の combine と同じ規則。 */
    if (!Array.isArray(shares) || shares.length < 2) throw new Error("断片が2つ以上必要です");
    const xs = shares.map(s => s.x);
    if (new Set(xs).size !== xs.length) throw new Error("同じ番号の断片が混ざっています");
    if (xs.some(x => !Number.isInteger(x) || x <= 0 || x >= base)) {
      throw new Error("断片の番号は1から" + (base - 1) + "の整数です");
    }
    const width = shares[0].symbols.length;
    if (shares.some(s => s.symbols.length !== width)) throw new Error("断片の記号数がそろっていません");
    shares.forEach(s => s.symbols.forEach(v => {
      if (!Number.isInteger(v) || v < 0 || v >= base) throw new Error("記号が範囲外です");
    }));

    const digits = [];
    for (let i = 0; i < width; i++) {
      let total = 0;
      for (let a = 0; a < shares.length; a++) {
        let num = 1, den = 1;
        for (let b = 0; b < shares.length; b++) {
          if (a === b) continue;
          num = (num * (((-shares[b].x) % base) + base)) % base;
          den = (den * ((((shares[a].x - shares[b].x) % base) + base) % base)) % base;
        }
        total = (total + shares[a].symbols[i] * num % base * _invMod(den, base)) % base;
      }
      digits.push(((total % base) + base) % base);
    }
    let value = 0n;
    for (const d of digits) value = value * BigInt(base) + BigInt(d);
    return {value: Number(value) <= Number.MAX_SAFE_INTEGER ? Number(value) : value, digits: digits};
  }

  return {noteToMidi, midiToNote, noteToFreq, slots, decode, bytesToHex, combineShares, combineThreshold,
    _generator, _rsEncode, _rsDecode, _syndromes, _solve, _toBase, _fromBase,
    _prime, _width, _payloadWidth, _widthToBytes,
    _primeBelow, _wireParams, _diffDecode, _interleaveOrder, _blockLayout, _root};
});
