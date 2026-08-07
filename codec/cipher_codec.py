"""暗号笛のエンコーダ・デコーダ。

基準笛との周波数比を使い、全笛共通の周波数変化を打ち消す。
ECCは素数体 GF(p) 上の短縮 Reed--Solomon 符号である。

CodecConfig.no_repeat=Trueにすると、隣り合う笛が必ず違う音になるよう符号化する
(差分写像+インターリーブ)。音が変わること自体が区切りの合図になるので、無音を
置かずに続けて吹いて読める。既定はFalseで従来どおりの符号化。
"""
from __future__ import annotations
import argparse
from dataclasses import dataclass
import functools
import itertools
import math
import os
import sys
from typing import Optional
import numpy as np

try:
    from .notes import midi_to_note, note_to_freq, note_to_midi
except ImportError:
    from notes import midi_to_note, note_to_freq, note_to_midi


@dataclass(frozen=True)
class CodecConfig:
    """音域、較正式、ECCをまとめた設定。"""
    lo_note: str = "F#6"
    hi_note: str = "F#7"
    step_cents: float = 100.0
    reference_note: str = "C7"
    calib_k: float = 91891.5
    calib_delta: float = 14.23
    ecc_parity: int = 2
    mode: str = "sequential"
    use_reference: bool = True   # 先頭の基準笛で温度・吹圧を打ち消す。Falseなら全笛データ＝絶対音程で読む
    decision_guard_cents: Optional[float] = None
    no_repeat: bool = False      # 隣り合う笛が同じ音にならない符号化。無音区切り無しで連続して吹ける

    def __post_init__(self):
        if self.step_cents <= 0 or self.ecc_parity < 0:
            raise ValueError("ステップは正、パリティは0以上が必要")
        if self.no_repeat and not self.use_reference:
            # 差分写像は直前の音を起点にする。1本目の起点は基準笛しかない。
            raise ValueError("no_repeatには基準笛(use_reference=True)が必要")
        lo, hi, ref = (note_to_midi(x) * 100.0 for x in
                       (self.lo_note, self.hi_note, self.reference_note))
        span = (hi - lo) / self.step_cents
        if hi < lo or not math.isclose(span, round(span), abs_tol=1e-9):
            raise ValueError("音域がスロット間隔で割り切れない")
        q = (ref - lo) / self.step_cents
        # 基準笛は音域(lo..hi)の外に置いてもよい（比読みの基準としてのみ使い、データ記号セット
        # には含めない）。従来どおり音域内に置くことも可能。要件はスロット格子上にあることだけ。
        if not math.isclose(q, round(q), abs_tol=1e-9):
            raise ValueError("reference_noteがスロット格子上にない")


@dataclass(frozen=True)
class Slot:
    """離散化した一つの笛スロット。"""
    index: int
    cents_from_lo: float
    freq_hz: float
    nearest_note: str


@dataclass
class EncodeResult:
    """符号化結果。"""
    notes: list[str]
    lengths: list[float]
    symbols: list[int]
    m: int
    p: int
    parity: int
    field_width: int
    message_symbols: list[int]
    codeword: list[int]


@dataclass
class FluteDecision:
    """一本のデータ笛の判定。"""
    slot_index: int
    residual_cents: float
    is_erasure: bool
    corrected: bool = False


@dataclass
class DecodeResult:
    """復号結果。"""
    payload: bytes
    decisions: list[FluteDecision]
    status: str
    symbols: list[int]
    corrected_count: int = 0
    erasure_count: int = 0


def slots(cfg: CodecConfig) -> list[Slot]:
    """下端から上端までを指定セント間隔で両端込みで列挙する。"""
    lo = note_to_midi(cfg.lo_note)
    count = (note_to_midi(cfg.hi_note) - lo) * 100.0 / cfg.step_cents
    if not math.isclose(count, round(count), abs_tol=1e-9):
        raise ValueError("音域がスロット間隔で割り切れない")
    f0 = note_to_freq(cfg.lo_note)
    return [Slot(i, i * cfg.step_cents, f0 * 2 ** (i * cfg.step_cents / 1200),
                 midi_to_note(round(lo + i * cfg.step_cents / 100)))
            for i in range(round(count) + 1)]


def ref_slot_index(cfg: CodecConfig) -> int:
    """基準笛のスロット番号を返す。"""
    return round((note_to_midi(cfg.reference_note) - note_to_midi(cfg.lo_note)) * 100 / cfg.step_cents)


def symbol_bits(cfg: CodecConfig) -> float:
    """一本のデータ笛が持つ情報量[bit]。"""
    return math.log2(_wire_params(cfg)[1])


def freq_to_length(f: float, cfg: CodecConfig) -> float:
    """周波数[Hz]を較正式で管長[mm]へ変換する。"""
    if f <= 0:
        raise ValueError("周波数は正が必要")
    return cfg.calib_k / f - cfg.calib_delta


def _prime(n):
    """n以上の最小素数を返す。"""
    while n < 2 or any(n % d == 0 for d in range(2, int(math.sqrt(n)) + 1)):
        n += 1
    return n


def _prime_below(n):
    """n以下の最大素数を返す。"""
    while n >= 2 and any(n % d == 0 for d in range(2, int(math.sqrt(n)) + 1)):
        n -= 1
    if n < 2:
        raise ValueError("素数体が取れない(スロットが少なすぎる)")
    return n


def _to_base(value, base, width=None):
    """非負整数をbig-endianのbase進数列へ変換する。"""
    if value < 0 or base < 2:
        raise ValueError("不正な値または底")
    out = [0] if value == 0 else []
    while value:
        value, d = divmod(value, base)
        out.append(d)
    out.reverse()
    if width is not None:
        if len(out) > width:
            raise ValueError("指定幅に収まらない")
        out = [0] * (width - len(out)) + out
    return out


def _from_base(digits, base):
    """big-endianのbase進数列を整数へ戻す。"""
    value = 0
    for d in digits:
        if not 0 <= d < base:
            raise ValueError("数字が範囲外")
        value = value * base + d
    return value


@functools.lru_cache(maxsize=None)
def _root(p):
    """GF(p)の原始元(最小の原始根)を返す。

    位数がp-1でないとRSの誤り位置が一意に定まらない。p=11,13では2なので
    従来の符号語は変わらず、2が原始根でないp(例えば7)でも符号が成立する。
    """
    for g in range(2, p):
        if len({pow(g, k, p) for k in range(1, p)}) == p - 1:
            return g
    return 1


def _generator(nsym, p):
    """RS生成多項式を高次側先頭で作る。"""
    g = [1]
    for r in range(1, nsym + 1):
        a, nxt = pow(_root(p), r, p), [0] * (len(g) + 1)
        for i, c in enumerate(g):
            nxt[i] = (nxt[i] + c) % p
            nxt[i + 1] = (nxt[i + 1] - c * a) % p
        g = nxt
    return g


def _rs_encode(message, nsym, p):
    """GF(p)上の系統的短縮RS符号語を作る。"""
    if not nsym:
        return list(message)
    if len(message) + nsym > p - 1:
        raise ValueError("RS符号長がp-1を超える")
    g, work = _generator(nsym, p), list(message) + [0] * nsym
    for i in range(len(message)):
        c = work[i]
        for j, x in enumerate(g):
            work[i + j] = (work[i + j] - c * x) % p
    return list(message) + [(-x) % p for x in work[-nsym:]]


def _syndromes(word, nsym, p):
    """RSシンドロームを返す。"""
    n = len(word)
    return [sum(v * pow(pow(_root(p), r, p), n - 1 - i, p) for i, v in enumerate(word)) % p
            for r in range(1, nsym + 1)]


def _solve(a, b, p):
    """素数体上の連立一次方程式を解く。"""
    n = len(b)
    z = [[x % p for x in row] + [b[i] % p] for i, row in enumerate(a)]
    for c in range(n):
        pivot = next((r for r in range(c, n) if z[r][c]), None)
        if pivot is None:
            return None
        z[c], z[pivot] = z[pivot], z[c]
        # pは素数なのでFermatの小定理で逆元を得る。
        inv = pow(z[c][c], p - 2, p)
        z[c] = [(x * inv) % p for x in z[c]]
        for r in range(n):
            if r != c:
                q = z[r][c]
                z[r] = [(x - q * y) % p for x, y in zip(z[r], z[c])]
    return [z[i][-1] for i in range(n)]


def _rs_decode(received, nsym, p, erasures=None):
    """誤りと消失を訂正し、(符号語, 訂正位置)を返す。"""
    erased, syn = set(erasures or ()), _syndromes(received, nsym, p)
    if not any(syn) and not erased:
        return list(received), set()
    candidates = [i for i in range(len(received)) if i not in erased]
    for count in range((nsym - len(erased)) // 2 + 1):
        for extra in itertools.combinations(candidates, count):
            pos = sorted(erased | set(extra))
            if not pos:
                continue
            a = [[pow(pow(_root(p), r, p), len(received) - 1 - i, p) for i in pos]
                 for r in range(1, len(pos) + 1)]
            mag = _solve(a, [(-x) % p for x in syn[:len(pos)]], p)
            if mag is None:
                continue
            trial = list(received)
            for i, x in zip(pos, mag):
                trial[i] = (trial[i] + x) % p
            if not any(_syndromes(trial, nsym, p)):
                return trial, set(pos)
    raise ValueError("RSで訂正できない")


def _width(m, p):
    """GF要素をbase-mで表す固定幅。"""
    w, cap = 1, m
    while cap < p:
        w, cap = w + 1, cap * m
    return w


def _payload_width(nbytes, m):
    """Bバイトを表すのに必要な最小のbase-m固定幅d (m**d >= 256**B)。"""
    if nbytes < 0:
        raise ValueError("バイト数が負")
    width, cap, target = 0, 1, 256 ** nbytes
    while cap < target:
        width, cap = width + 1, cap * m
    return width


def _width_to_bytes(width, m):
    """データ記号数dから唯一のバイト数Bを逆算する(d→Bは一対一)。"""
    nbytes = 0
    while _payload_width(nbytes, m) < width:
        nbytes += 1
    if _payload_width(nbytes, m) != width:
        raise ValueError("データ記号数が不正")
    return nbytes


def _wire_params(cfg: CodecConfig):
    """(スロット数m, 記号の底mb, 笛の底wb, 素数体p, 1記号あたりの笛本数w)を返す。

    既定(no_repeat=False)は従来どおり底mでp=m以上の最小素数。
    no_repeat=Trueでは差分値が0..m-2のm-1通りしかないので、笛1本=記号1個を保つ
    ためにpをm-1以下の最大素数に取る(m=11ならp=7)。m-1が素数でない分だけ
    1本あたりの情報量はlog2(m-1)より落ちるが、笛1本=RS記号1個という
    対応が保たれるのでインターリーブがそのまま効く。
    """
    m = len(slots(cfg))
    if not cfg.no_repeat:
        p = _prime(m)
        return m, m, m, p, _width(m, p)
    p = _prime_below(m - 1)
    return m, p, m - 1, p, 1


def _diff_encode(values, m, start):
    """差分値の列を、隣り合う値が決して等しくならないスロット列にする。"""
    out, prev = [], start % m
    for d in values:
        if not 0 <= d <= m - 2:
            raise ValueError("差分値が範囲外")
        prev = (prev + 1 + d) % m
        out.append(prev)
    return out


def _diff_decode(seq, m, start):
    """スロット列を差分値の列へ戻す(_diff_encodeの逆)。"""
    out, prev = [], start % m
    for s in seq:
        out.append((s - prev - 1) % m)
        prev = s
    return out


def _balanced_sizes(total, cap):
    """totalをcap以下のブロックへ、大きさの差が1以下になるよう分ける。

    均等割りにするのはインターリーブのため。片方のブロックだけ長く残ると、
    末尾で同じブロックの記号が隣り合ってしまう。
    """
    if total <= 0:
        return []
    k = -(-total // cap)
    return [total // k + (1 if j < total % k else 0) for j in range(k)]


def _interleave_order(sizes):
    """送出順t → ブロック連結順の位置、の対応を返す。

    列ごとに各ブロックから1記号ずつ拾う。ブロックが2個以上あれば隣り合う
    送出位置は必ず別ブロックになるので、1本の読み違いが各ブロック1記号ずつに
    分かれる。ブロックが1個しかない短い秘密では混ぜようがなく素通りする。
    """
    offsets, at = [], 0
    for size in sizes:
        offsets.append(at)
        at += size
    order = []
    for i in range(max(sizes, default=0)):
        order.extend(offsets[b] + i for b, size in enumerate(sizes) if i < size)
    return order


def _block_layout(total, parity, block_data):
    """受信記号数から各RSブロックの符号語長を復元する。"""
    if total <= 0:
        return []
    for k in range(1, total + 1):
        data = total - k * parity
        if data < k:
            break
        if -(-data // block_data) == k:
            return [data // k + parity + (1 if j < data % k else 0) for j in range(k)]
    raise ValueError("ブロック構成が不正")


def _encode_message(message: list[int], cfg: CodecConfig) -> EncodeResult:
    """記号列にRSパリティを付け、基準笛先頭の笛列へ変換する。"""
    table = slots(cfg)
    m, mb, wb, p, width = _wire_params(cfg)
    block_data = (p - 1) - cfg.ecc_parity
    if block_data < 1:
        raise ValueError("パリティがRSブロックに収まらない")
    if cfg.no_repeat:
        sizes, codeword, at = _balanced_sizes(len(message), block_data), [], 0
        for size in sizes:
            codeword.extend(_rs_encode(message[at:at + size], cfg.ecc_parity, p))
            at += size
        block_lengths = [s + cfg.ecc_parity for s in sizes]
        sent = [codeword[g] for g in _interleave_order(block_lengths)]
    else:
        codeword = []
        for start in range(0, len(message), block_data):
            codeword.extend(_rs_encode(message[start:start + block_data],
                                       cfg.ecc_parity, p))
        sent = codeword
    wire = [d for x in sent for d in _to_base(x, wb, width)]
    if cfg.no_repeat:
        # 差分写像。基準笛のスロットを起点に、必ず1以上進むので隣が同じにならない。
        wire = _diff_encode(wire, m, ref_slot_index(cfg))
    # データ笛は音域テーブルのスロット、基準笛は基準音から直接（音域外でもよい）。
    data_notes = [table[i].nearest_note for i in wire]
    data_lengths = [freq_to_length(table[i].freq_hz, cfg) for i in wire]
    if cfg.use_reference:
        notes = [cfg.reference_note] + data_notes
        lengths = [freq_to_length(note_to_freq(cfg.reference_note), cfg)] + data_lengths
    else:
        notes, lengths = data_notes, data_lengths
    return EncodeResult(notes, lengths, wire, m, p, cfg.ecc_parity, width, message, codeword)


def encode(payload: bytes, cfg: CodecConfig = CodecConfig()) -> EncodeResult:
    """バイト列を固定幅base-m展開して暗号笛列へ符号化する。

    長さヘッダは持たない。幅d=(m**d>=256**Bの最小d)が本数から一意に
    定まるため、笛の本数そのものが長さ情報を兼ねる。
    """
    if cfg.mode != "sequential":
        raise ValueError("未対応のmode")
    mb = _wire_params(cfg)[1]
    width = _payload_width(len(payload), mb)
    message = _to_base(int.from_bytes(payload, "big"), mb, width) if payload else []
    return _encode_message(message, cfg)


def encode_symbols(symbols: list[int], cfg: CodecConfig = CodecConfig()) -> EncodeResult:
    """0..mb-1の記号列そのものを暗号笛列へ符号化する(symbolsモード)。

    記号の上限mbは既定でスロット数m、no_repeat=Trueでは差分値の上限m-2以下に
    取った素数体の大きさ(m=11ならp=7)になる。
    """
    mb = _wire_params(cfg)[1]
    message = [int(s) for s in symbols]
    if any(not 0 <= s < mb for s in message):
        raise ValueError("記号が範囲外")
    return _encode_message(message, cfg)


def decode(measured_freqs: list[float], cfg: CodecConfig = CodecConfig(),
           positions_known=True) -> DecodeResult:
    """周波数列を基準笛との比で丸め、ECC訂正して復号する。"""
    if cfg.mode not in ("sequential", "symbols"):
        return DecodeResult(b"", [], "error: 未対応のmode", [])
    if not measured_freqs or any(f <= 0 for f in measured_freqs):
        return DecodeResult(b"", [], "error: 正の周波数が必要", [])
    table = slots(cfg)
    if cfg.use_reference:
        # 先頭(または最も基準音に近い笛)を基準に、周波数比で温度・吹圧を打ち消す。
        # 基準の公称周波数は基準音から直接求める（データ音域の外に置いてもよい）。
        ref_nominal = note_to_freq(cfg.reference_note)
        rp = 0 if positions_known else min(range(len(measured_freqs)),
            key=lambda i: abs(1200 * math.log2(measured_freqs[i] / ref_nominal)))
        ref = measured_freqs[rp]
        data = measured_freqs[:rp] + measured_freqs[rp + 1:]
        ratios = [s.freq_hz / ref_nominal for s in table]
        resid = lambda f: [1200 * math.log2((f / ref) / x) for x in ratios]
    else:
        # 基準笛なし＝全笛データ。絶対音程で各スロットに丸める(温度・吹圧補正なし)。
        data = list(measured_freqs)
        resid = lambda f: [1200 * math.log2(f / s.freq_hz) for s in table]
    guard = cfg.step_cents / 2 if cfg.decision_guard_cents is None else cfg.decision_guard_cents
    decisions, wire, erased = [], [], set()
    for j, f in enumerate(data):
        residuals = resid(f)
        i = min(range(len(table)), key=lambda x: abs(residuals[x]))
        bad = abs(residuals[i]) > guard
        decisions.append(FluteDecision(i, residuals[i], bad))
        wire.append(i)
        if bad:
            erased.add(j)
    m, mb, wb, p, w = _wire_params(cfg)
    try:
        digits, suspect = wire, erased
        if cfg.no_repeat:
            # 差分の逆写像。起点は基準笛の公称スロット。
            digits = _diff_decode(wire, m, ref_slot_index(cfg))
            # 1本の読み違いは差分2個を汚すので、消失は次の記号へも波及させる。
            suspect = erased | {j + 1 for j in erased if j + 1 < len(digits)}
        if len(digits) % w:
            raise ValueError("記号数が不正")
        received, erasures = [], set()
        for start in range(0, len(digits), w):
            chunk = digits[start:start + w]
            pos = start // w
            # 差分がm-1(=隣と同じ音)は符号化では起こり得ない。読み違いの印として消失にする。
            invalid = any(d >= wb for d in chunk)
            value = 0 if invalid else _from_base(chunk, wb)
            if invalid or value >= p or any(x in suspect for x in range(start, start + w)):
                erasures.add(pos)
                value %= p
            received.append(value)
        if cfg.no_repeat:
            sizes = _block_layout(len(received), cfg.ecc_parity,
                                  (p - 1) - cfg.ecc_parity)
            order = _interleave_order(sizes)
        else:
            sizes = [min(p - 1, len(received) - s)
                     for s in range(0, len(received), p - 1)]
            order = list(range(len(received)))
        # 送出順(=笛の並び)をブロック連結順へ戻す。
        block_major, block_erasures = [0] * len(received), set()
        for t, g in enumerate(order):
            block_major[g] = received[t]
            if t in erasures:
                block_erasures.add(g)
        changed, msg, at = set(), [], 0
        for size in sizes:
            block = block_major[at:at + size]
            if len(block) < cfg.ecc_parity + 1:
                raise ValueError("RSブロック長が不正")
            decoded, block_changed = _rs_decode(
                block, cfg.ecc_parity, p,
                {pos - at for pos in block_erasures if at <= pos < at + size})
            changed.update(at + pos for pos in block_changed)
            msg.extend(decoded[:size - cfg.ecc_parity])
            at += size
        if cfg.mode == "symbols":
            payload, out_symbols = b"", msg
        else:
            nbytes = _width_to_bytes(len(msg), mb)
            payload, out_symbols = _from_base(msg, mb).to_bytes(nbytes, "big"), wire
        inverse = {g: t for t, g in enumerate(order)}
        for pos in changed:
            t = inverse[pos]
            for j in range(t * w, min((t + 1) * w, len(decisions))):
                decisions[j].corrected = True
        return DecodeResult(payload, decisions, "corrected" if changed else "ok",
                            out_symbols, len(changed), len(erasures))
    except (ValueError, OverflowError) as exc:
        return DecodeResult(b"", decisions, "error: %s" % exc, wire, 0, len(erased))


def simulate(symbols_or_notes, cfg: CodecConfig = CodecConfig(), common_mode_pct=0.0,
             per_flute_sigma_cents=0.0, seed=None) -> list[float]:
    """音名またはスロット列に共通・差動変動を与える。"""
    table, freqs = slots(cfg), []
    for x in symbols_or_notes:
        freqs.append(note_to_freq(x) if isinstance(x, str) else table[int(x)].freq_hz)
    noise = np.random.default_rng(seed).normal(0, per_flute_sigma_cents, len(freqs))
    return [f * (1 + common_mode_pct / 100) * 2 ** (c / 1200) for f, c in zip(freqs, noise)]


def selftest(trials: int = 100, cfg: CodecConfig = CodecConfig()) -> dict:
    """共通+3%、差動σ15centで相対復号と絶対丸めを比較する。"""
    rng, relative, absolute = np.random.default_rng(20260720), 0, 0
    table = slots(cfg)
    for _ in range(trials):
        payload = bytes([int(rng.integers(256))])
        enc = encode(payload, cfg)
        measured = simulate(enc.notes, cfg, 3, 15, int(rng.integers(2**32)))
        relative += decode(measured, cfg).payload == payload
        raw = [min(range(len(table)), key=lambda i: abs(1200 * math.log2(f / table[i].freq_hz)))
               for f in measured[1:]]
        absolute += raw == enc.symbols
    return dict(trials=trials, relative_success=relative,
                relative_rate=relative / trials if trials else 0,
                absolute_success=absolute, absolute_rate=absolute / trials if trials else 0)


def build_stl_from_notes(notes: list[str], out_path: str) -> str:
    """音名列(基準笛先頭)をコームSTLとして保存する。"""
    try:
        from .halfcut import scale_comb
    except ImportError:
        from halfcut import scale_comb
    mesh, _, _, _ = scale_comb(notes=notes, reverse=False)
    mesh.export(out_path)
    return os.path.abspath(out_path)


def build_stl(payload: bytes, cfg: CodecConfig, out_path: str) -> str:
    """暗号笛列を基準笛先頭のコームSTLとして保存する。"""
    return build_stl_from_notes(encode(payload, cfg).notes, out_path)


def _parser():
    """CLI解析器を作る。"""
    p = argparse.ArgumentParser(description="暗号笛コーデック")
    p.add_argument("--lo", default="F#6"); p.add_argument("--hi", default="F#7")
    p.add_argument("--step-cents", type=float, default=100.0); p.add_argument("--ref", default="C7")
    p.add_argument("--parity", type=int, default=2); p.add_argument("--mode", default="sequential")
    p.add_argument("--no-repeat", action="store_true", help="隣り合う笛が同じ音にならない符号化")
    sub = p.add_subparsers(dest="command", required=True)
    e = sub.add_parser("encode")
    g = e.add_mutually_exclusive_group(required=True)
    g.add_argument("--payload-hex"); g.add_argument("--symbols")
    e.add_argument("--out")
    d = sub.add_parser("decode"); d.add_argument("--freqs", required=True)
    s = sub.add_parser("selftest"); s.add_argument("--trials", type=int, default=100)
    sub.add_parser("slots")
    return p


def main(argv=None):
    """CLIを実行する。"""
    a = _parser().parse_args(argv)
    cfg = CodecConfig(a.lo, a.hi, a.step_cents, a.ref, ecc_parity=a.parity, mode=a.mode,
                      no_repeat=a.no_repeat)
    if a.command == "encode":
        if a.symbols is not None:
            cfg = CodecConfig(a.lo, a.hi, a.step_cents, a.ref,
                              ecc_parity=a.parity, mode="symbols",
                              no_repeat=a.no_repeat)
            result = encode_symbols([int(x) for x in a.symbols.split(",")], cfg)
        else:
            result = encode(bytes.fromhex(a.payload_hex), cfg)
        print("記号:", ",".join(map(str, result.symbols))); print("音名:", ",".join(result.notes))
        print("管長[mm]:", ",".join("%.3f" % x for x in result.lengths))
        if a.out: print("STL:", build_stl_from_notes(result.notes, a.out))
    elif a.command == "decode":
        result = decode([float(x) for x in a.freqs.split(",")], cfg)
        print("状態:", result.status)
        if cfg.mode == "symbols": print("記号:", ",".join(map(str, result.symbols)))
        else: print("ペイロード:", result.payload.hex())
    elif a.command == "selftest":
        r = selftest(a.trials, cfg)
        print("相対復号: {relative_success}/{trials} ({relative_rate:.1%})".format(**r))
        print("絶対復号: {absolute_success}/{trials} ({absolute_rate:.1%})".format(**r))
    else:
        for s in slots(cfg): print("%2d %+7.1f cent %9.3f Hz %s" % (s.index, s.cents_from_lo, s.freq_hz, s.nearest_note))
    return 0


if __name__ == "__main__":
    sys.exit(main())
