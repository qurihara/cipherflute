"""しきい値秘密分散（Shamir）を、暗号笛の記号の上で行う。

暗号笛の記号は素数体 GF(p) の要素である（12スロット・隣接同音禁止なら p=11）。素数体では
Shamirの分散がそのまま使えるので、[* n個のうち k個あれば復元でき、k-1個以下では何も分からない]
分け方ができる。

    k=2, n=2 … いままでのカード2枚（片方に乱数、もう片方に秘密−乱数）と同じもの
    k=2, n=3 … 3つのうちどれか2つで復元できる。1つ失っても大丈夫で、1つ盗まれても漏れない

仕組み（k=2の場合）。記号ごとに1次式 f(x) = s + a·x を立てる。s は秘密の記号、a は乱数である。
番号 j の断片には f(j) を入れる。2つの断片 (j1, y1)、(j2, y2) があれば、
    a = (y2 - y1) / (j2 - j1),   s = y1 - a·j1
で s が出る。1つしか無ければ a が乱数のままなので、s はどの値も等しくありえる。

秘密の記号数がそのまま断片の記号数になる。つまり[* 断片1つは秘密と同じ大きさ]であり、
2-of-2でも2-of-3でも、1つの担体に入る量が秘密の上限を決める。
"""
from __future__ import annotations

import argparse
import random


def _inv(a: int, p: int) -> int:
    """GF(p) での逆数。p は素数である前提。"""
    a %= p
    if a == 0:
        raise ZeroDivisionError("0の逆数は無い")
    return pow(a, p - 2, p)


def split(secret_symbols, k: int, n: int, p: int = 11, rng: random.Random | None = None):
    """秘密の記号列を n 個の断片へ分ける。k 個そろえば復元できる。

    戻り値は [(番号, 記号列), ...]。番号は 1 から n までである（0 は秘密そのものなので使わない）。
    """
    if not 2 <= k <= n:
        raise ValueError("k は2以上 n 以下にする")
    if n >= p:
        raise ValueError("断片の数は素数体の大きさ未満にする（p=%d なので最大 %d 個）" % (p, p - 1))
    for s in secret_symbols:
        if not 0 <= s < p:
            raise ValueError("記号が 0 から %d の範囲に無い" % (p - 1))
    rng = rng or random.SystemRandom()

    shares = [(j, []) for j in range(1, n + 1)]
    for s in secret_symbols:
        # 定数項が秘密、それ以外は乱数の (k-1) 次多項式。
        # [* 最高次の係数は 0 にしてはいけない]。0 だと多項式の次数が下がり、k-1個で
        # 復元できてしまう。k=2 で係数が0なら多項式は定数になり、全断片が秘密そのものに
        # なって[* 1枚で漏れる]（2026-07-31に、9枚すべての第1記号が同じ値になって気づいた）。
        coeff = ([s] + [rng.randrange(p) for _ in range(k - 2)]
                 + [rng.randrange(1, p)])
        for j, out in shares:
            y = 0
            for c in reversed(coeff):          # ホーナー法
                y = (y * j + c) % p
            out.append(y)
    return [(j, out) for j, out in shares]


def combine(shares, p: int = 11):
    """断片から秘密を戻す。shares は [(番号, 記号列), ...] で、k個以上あればよい。

    ラグランジュ補間を x=0 で評価する（定数項＝秘密）。
    """
    if len(shares) < 2:
        raise ValueError("断片が2つ以上必要である")
    xs = [j for j, _ in shares]
    if len(set(xs)) != len(xs):
        raise ValueError("同じ番号の断片が混ざっている")
    width = len(shares[0][1])
    if any(len(y) != width for _, y in shares):
        raise ValueError("断片の記号数がそろっていない")

    out = []
    for i in range(width):
        total = 0
        for a, (ja, ya) in enumerate(shares):
            num, den = 1, 1
            for b, (jb, _) in enumerate(shares):
                if a == b:
                    continue
                num = (num * (-jb)) % p
                den = (den * (ja - jb)) % p
            total = (total + ya[i] * num * _inv(den, p)) % p
        out.append(total)
    return out


def value_of(symbols, p: int = 11) -> int:
    v = 0
    for s in symbols:
        v = v * p + s
    return v


def symbols_of(value: int, width: int, p: int = 11):
    out = []
    for _ in range(width):
        out.append(value % p)
        value //= p
    if value:
        raise ValueError("指定の桁数に収まらない")
    return out[::-1]


def main(argv=None):
    ap = argparse.ArgumentParser(description="暗号笛の記号でしきい値秘密分散を行う")
    ap.add_argument("--secret", type=int, required=True, help="秘密（整数）")
    ap.add_argument("--width", type=int, default=6, help="記号の数（既定6＝20.8ビット）")
    ap.add_argument("-k", type=int, default=2, help="復元に必要な数")
    ap.add_argument("-n", type=int, default=3, help="作る断片の数")
    ap.add_argument("--base", type=int, default=11, help="記号の底（素数）")
    ap.add_argument("--seed", type=int, default=None, help="乱数の種（再現したいとき）")
    a = ap.parse_args(argv)

    rng = random.Random(a.seed) if a.seed is not None else None
    sym = symbols_of(a.secret, a.width, a.base)
    shares = split(sym, a.k, a.n, a.base, rng)
    print("秘密 %d（%d進%d桁 = %s）" % (a.secret, a.base, a.width, ",".join(map(str, sym))))
    print("%d個のうち%d個で復元できる分け方:" % (a.n, a.k))
    for j, y in shares:
        print("  断片%d: %s（値 %d）" % (j, ",".join(map(str, y)), value_of(y, a.base)))
    import itertools
    for combo in itertools.combinations(shares, a.k):
        got = combine(list(combo), a.base)
        mark = "ok" if got == sym else "NG"
        print("  断片%s から復元 → %d [%s]"
              % ("+".join(str(j) for j, _ in combo), value_of(got, a.base), mark))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
