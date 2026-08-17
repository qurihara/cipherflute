#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""紙の早見表による手復号の手順が、実装の復号器と一致することを確かめる。

    python3 scripts/verify_manual_decode.py

なぜ要るか
----------
論文は「紙の対照表があれば人手で誤り訂正まで行える」と述べる。**述べるだけでは
足りない。手順が本当に正しいことを、実装と突き合わせて示す必要がある。**
この検証が通ることが、早見表（docs/cipher/manual_decode_card.md）の根拠である。

手順の要点
----------
GF(11) の原始根は 2 である。したがって 10 項の対数表と 10 項のべき乗表があれば、
掛け算は log の足し算、割り算は log の引き算になる。**11×11 の乗算表は要らない。**

パリティ2記号のとき、誤り1つは次の2式で求まる。

    位置の指数 = (log S2 - log S1) mod 10        →  j = (n-1-位置の指数) mod 10
    log e      = (2 log S1 - log S2) mod 10      →  e = 2^(log e)

すなわち**引き算2回と表引き2回**で、どの笛をどれだけ間違えたかが分かる。
"""
from __future__ import annotations
import os
import random
import sys

# 公開版では、このファイルと同じ場所に cipher_codec.py を置いてある
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cipher_codec as cc  # noqa: E402

P, ALPHA, NSYM = 11, 2, 2
POW = [pow(ALPHA, k, P) for k in range(P - 1)]
LOG = {POW[k]: k for k in range(P - 1)}


def manual_fix(recv: list[int], n: int) -> list[int] | None:
    """早見表の手順3をそのまま実行する。紙の上でできることしかしない。"""
    s1, s2 = cc._syndromes(recv, NSYM, P)
    if s1 == 0 and s2 == 0:
        return list(recv)
    if s1 == 0 or s2 == 0:
        return None                      # 誤り1つでは説明できない
    j = (n - 1 - (LOG[s2] - LOG[s1]) % (P - 1)) % (P - 1)
    if j >= n:
        return None
    e = POW[(2 * LOG[s1] - LOG[s2]) % (P - 1)]
    out = list(recv)
    out[j] = (out[j] - e) % P
    return out


def manual_fix_erasure(recv: list[int], n: int, j: int) -> list[int]:
    """鳴らなかった笛の位置が分かっている場合（消失1つ）。"""
    s1, _ = cc._syndromes(recv, NSYM, P)
    if s1 == 0:
        return list(recv)
    e = POW[(LOG[s1] - (n - 1 - j)) % (P - 1)]
    out = list(recv)
    out[j] = (out[j] - e) % P
    return out


def main() -> int:
    random.seed(7)
    ok = ng = 0

    for _ in range(300):                 # 誤り1つ
        k = random.randint(2, 8)
        word = cc._rs_encode([random.randrange(P) for _ in range(k)], NSYM, P)
        n = len(word)
        pos = random.randrange(n)
        recv = list(word)
        recv[pos] = random.choice([v for v in range(P) if v != word[pos]])
        if manual_fix(recv, n) == word:
            ok += 1
        else:
            ng += 1
            print("誤り1つで失敗:", word, pos, recv[pos])

    for _ in range(300):                 # 消失1つ（鳴らなかった笛が分かっている）
        k = random.randint(2, 8)
        word = cc._rs_encode([random.randrange(P) for _ in range(k)], NSYM, P)
        n = len(word)
        pos = random.randrange(n)
        recv = list(word)
        recv[pos] = 0                    # 読めなかったので仮に0を置く
        if manual_fix_erasure(recv, n, pos) == word:
            ok += 1
        else:
            ng += 1
            print("消失1つで失敗:", word, pos)

    print(f"■ 手復号の手順　{ok}/{ok + ng} 一致")
    if ng:
        return 1
    print("   引き算2回と表引き2回で、実装の復号器と同じ結果になる。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
