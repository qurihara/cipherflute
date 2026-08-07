#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""最小の例。ふつうの箱に笛を4本、鳴る状態で埋め込む。

    python3 box_with_flutes.py

この例が示すのは1点だけである。**笛を重ねるのではなく、笛の外形の凸包でホストに
ポケットを彫り抜いてから笛を戻す**。彫らずに重ねると、ホストの材料が笛の空洞へ
入り込み、見た目は正しくても音が出ない。

最後に、ボアが本当に中空のまま残っているかを数値で確かめる。
"""
import argparse
import os
import sys

import numpy as np
import trimesh

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import mini10                     # noqa: E402
import embed_flutes as EF         # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="箱に笛を4本埋め込む")
    ap.add_argument("-o", "--out", default=os.path.join(HERE, "box_with_flutes.stl"))
    ap.add_argument("--notes", default="C7,E7,G7,C7", help="埋め込む音（コンマ区切り）")
    args = ap.parse_args()
    notes = [n.strip() for n in args.notes.split(",") if n.strip()]

    # 笛は外形をそろえた版を使う。長さから音が読めないようにするためである
    l_max = mini10.uniform_body_length(
        [mini10.length_for_note(n) for n in mini10.CALIB12])

    flutes = []
    fw = fd = fh = 0.0
    for i, note in enumerate(notes):
        f = mini10.uniform_flute(mini10.length_for_note(note), l_max)
        fw, fd, fh = f.extents
        flutes.append(f)

    pitch = fd + 1.5              # 笛どうしの間
    wall = 3.0                    # 箱の壁
    W = fw + 2 * wall
    D = pitch * len(notes) + 2 * wall
    H = fh + wall

    host = trimesh.creation.box(extents=[W, D, H])
    host.apply_translation([W / 2, D / 2, H / 2])

    # 笛を置く。窓は上（+z）を向けたまま、箱の上面と面一にする。
    # 窓が真上を向く置き方は、印刷して鳴る範囲の真ん中にあたる
    placed, bore_pts = [], []
    for i, (note, f) in enumerate(zip(notes, flutes)):
        m = f.copy()
        m.apply_translation([wall, wall + pitch * i, H - fh])
        placed.append(m)
        lo, hi = m.bounds
        # ボアの中にあたる点。床のすぐ上、長さの中ほど
        bore_pts.append([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2] + 1.2])
        print("  %d本目 %-4s を置いた" % (i + 1, note))

    # ★ここが核心★ 凸包でポケットを彫ってから笛を戻す
    combined, carved = EF.carve_and_place(host, placed)
    combined.export(args.out)

    print()
    print("箱 %.1f x %.1f x %.1f mm に笛%d本 -> %s"
          % (W, D, H, len(notes), os.path.basename(args.out)))

    # 検証。ボアが中空のまま残っていなければ鳴らない
    hollow = EF.bore_hollow(combined, bore_pts)
    print()
    print("ボアが中空か: %s" % ("すべて中空（よい）" if all(hollow)
                              else "★埋まっている★ %s" % hollow))

    # 彫らなかった場合との比較。これをやると埋まることを示す
    naive = trimesh.util.concatenate([host] + placed)
    bad = EF.bore_hollow(naive, bore_pts)
    print("（参考）彫らずに重ねた場合: %s"
          % ("中空" if all(bad) else "★%d本のボアが埋まる★" % sum(1 for b in bad if not b)))
    print()
    print("刷る前に、向きと空洞をそれぞれ検査すること（../HOWTO.md）。")


if __name__ == "__main__":
    main()
