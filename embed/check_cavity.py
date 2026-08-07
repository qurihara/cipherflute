"""印刷用3mfの実gcodeを読み、笛の空気の通り道に材料が入っていないかを確かめる。

なぜ要るか
----------
笛が鳴るのは、ボア（共鳴管）・風道・窓の中が空のままであるときだけである。日用品へ
埋め込むとき、ホスト側の材料がその空間へ入り込むと、見た目は正しくても音が出ない。
スライスまで済ませた実gcodeで確かめるのが唯一の確実な方法である。

考え方
------
[* 笛の凸包の中にありながら、笛の実体の外にある空間]が、空気の通り道である。ボアは
吸込口と窓で外気につながっているので「閉じた殻」としては現れず、殻を数える検査では
見つけられない（2026-07-29 に一度これで誤った）。

そこで逆向きに調べる。gcode の押出線分を細かい点に分け、笛の凸包に入る点だけを取り出し、
その点が笛の実体からどれだけ離れているかを測る。実体の外へ [* しきい値以上] はみ出した
押出があれば、空洞に材料が置かれている。

使い方:
    python3 scripts/check_flute_cavity.py \\
        --design out/bookstand_v4_share3.3mf \\
        --print  out/bookstand_v4_share3_petg_h2d.gcode.3mf
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import zipfile

import numpy as np
import trimesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from fue.check_cavity import load_segments  # noqa: E402


def bed_matrix(three_mf: str) -> np.ndarray:
    """3mf の build item transform を 4x4 の同次行列にして返す。

    BambuStudio は読み込んだ形の外接直方体の中心を原点に置き直してから、この行列で
    ベッド上へ動かす。したがって設計の座標をベッドの座標へ移すには、[* 先に外接直方体の
    中心を引いてから]この行列を掛ける必要がある（center_of_design を参照）。
    """
    import xml.etree.ElementTree as ET

    with zipfile.ZipFile(three_mf) as z:
        root = ET.fromstring(z.read("3D/3dmodel.model"))

    def tag(e):
        return e.tag.rsplit("}", 1)[-1]

    def mat(s):
        if not s:
            return np.eye(4)
        m = [float(v) for v in s.split()]
        return np.array([[m[0], m[3], m[6], m[9]],
                         [m[1], m[4], m[7], m[10]],
                         [m[2], m[5], m[8], m[11]],
                         [0.0, 0.0, 0.0, 1.0]])

    objects = {}
    for e in root.iter():
        if tag(e) == "object":
            objects[e.get("id")] = e

    def resolve(obj_id, depth=0):
        """object をたどり、実体のメッシュへ至るまでの変換を掛け合わせる。

        BambuStudio の 3mf は、build の item が単位行列で、実際の配置が
        components の中に入っていることがある（2026-07-30 に踏んだ）。
        """
        obj = objects.get(obj_id)
        if obj is None or depth > 8:
            return np.eye(4)
        for e in obj.iter():
            if tag(e) == "component":
                return mat(e.get("transform")) @ resolve(e.get("objectid"), depth + 1)
        return np.eye(4)

    for e in root.iter():
        if tag(e) == "build":
            for it in e:
                if tag(it) == "item":
                    return mat(it.get("transform")) @ resolve(it.get("objectid"))
    return np.eye(4)


def group_parts(parts):
    """連結成分を笛ごとにまとめる。

    1本の笛は「外側の殻」と「ボアの内向きの殻」に分かれて出てくるので、そのままでは
    本数が2倍に見える。外接直方体が他方に含まれるものは同じ笛だとみなしてまとめる。
    """
    order = sorted(range(len(parts)),
                   key=lambda i: -np.prod(parts[i].bounds[1] - parts[i].bounds[0]))
    groups = []          # [(lo, hi, [部品...])]
    for i in order:
        lo, hi = parts[i].bounds
        for g in groups:
            if np.all(lo >= g[0] - 0.2) and np.all(hi <= g[1] + 0.2):
                g[2].append(parts[i])
                break
        else:
            groups.append((lo, hi, [parts[i]]))
    return [trimesh.util.concatenate(g[2]) for g in groups]


def extract_gcode(three_mf: str, tmp_dir: str) -> str:
    out = os.path.join(tmp_dir, "plate_1.gcode")
    with zipfile.ZipFile(three_mf) as z:
        with open(out, "wb") as fp:
            fp.write(z.read("Metadata/plate_1.gcode"))
    return out


def sample_segments(segs: dict, step: float = 0.4) -> np.ndarray:
    """z -> 線分 の辞書を、(x, y, z) の点群へほどく。"""
    pts = []
    for z, ss in segs.items():
        a = np.asarray(ss, dtype=float)
        if not len(a):
            continue
        x0, y0, x1, y1 = a[:, 0], a[:, 1], a[:, 2], a[:, 3]
        length = np.hypot(x1 - x0, y1 - y0)
        n = np.clip((length / step).astype(int) + 1, 1, 200)
        for i in range(len(a)):
            t = np.linspace(0.0, 1.0, n[i])
            pts.append(np.stack([x0[i] + t * (x1[i] - x0[i]),
                                 y0[i] + t * (y1[i] - y0[i]),
                                 np.full(len(t), z)], axis=1))
    return np.concatenate(pts) if pts else np.zeros((0, 3))


def main(argv=None):
    ap = argparse.ArgumentParser(description="笛の空気の通り道が空いているかを実gcodeで確かめる")
    ap.add_argument("--design", required=True, help="設計3mf（笛のジオメトリを含む）")
    ap.add_argument("--print", dest="printed", required=True, help="スライス済みの印刷用3mf")
    ap.add_argument("--flute-name", default="flute", help="笛のジオメトリ名に含まれる語")
    ap.add_argument("--tol", type=float, default=0.35,
                    help="実体からこれだけ外へ出た押出を異常とみなす[mm]")
    ap.add_argument("--step", type=float, default=0.4, help="押出線分を刻む間隔[mm]")
    ap.add_argument("--max-points", type=int, default=60000,
                    help="1本あたり距離を測る点の上限（超えたら等間隔に間引く）")
    args = ap.parse_args(argv)

    scene = trimesh.load(args.design)
    flutes = [g for name, g in scene.geometry.items() if args.flute_name in name]
    if not flutes:
        raise SystemExit("笛のジオメトリが見つからない（--flute-name を確かめる）")
    whole = trimesh.util.concatenate(list(scene.geometry.values()))
    center = (whole.bounds[0] + whole.bounds[1]) / 2.0
    mesh = trimesh.util.concatenate(flutes)
    mesh.apply_translation(-center)
    mesh.apply_transform(bed_matrix(args.printed))
    parts = list(mesh.split(only_watertight=False))
    if not parts:
        parts = [mesh]
    parts = group_parts(parts)
    print("笛 %d本を調べる（ベッド座標 x %.1f〜%.1f, y %.1f〜%.1f, z %.1f〜%.1f）"
          % ((len(parts),) + tuple(np.round(mesh.bounds.T.reshape(-1), 1))))

    import tempfile
    tmp = tempfile.mkdtemp()
    try:
        gcode = extract_gcode(args.printed, tmp)
        segs = load_segments(gcode)
    finally:
        pass
    zs = np.array(sorted(segs.keys()))
    print("gcodeの層 %d 枚、z %.2f〜%.2f mm" % (len(zs), zs.min(), zs.max()))

    pts = sample_segments(segs, args.step)
    print("押出の点 %d 個へほどいた" % len(pts))

    ng_total = 0
    for i, part in enumerate(parts, 1):
        lo, hi = part.bounds
        sel = np.all((pts >= lo - 0.5) & (pts <= hi + 0.5), axis=1)
        cand = pts[sel]
        if not len(cand):
            print("  笛%2d … この範囲に押出が無い（★要確認）" % i)
            ng_total += 1
            continue
        hull = part.convex_hull
        inside_hull = hull.contains(cand)
        cand = cand[inside_hull]
        if not len(cand):
            print("  笛%2d … 凸包の中に押出が無い（★要確認）" % i)
            ng_total += 1
            continue
        thinned = ""
        if len(cand) > args.max_points:
            idx = np.linspace(0, len(cand) - 1, args.max_points).astype(int)
            cand = cand[idx]
            thinned = "（間引いた）"
        d = trimesh.proximity.signed_distance(part, cand)   # 実体の内側が正
        ng = int((d < -args.tol).sum())
        worst = float(-d.min()) if len(d) else 0.0
        mark = "ok" if ng == 0 else "★材料が空洞に入っている"
        print("  笛%2d … 凸包内の押出 %6d 点%s、実体の外へ最大 %.2fmm、しきい値超え %d 点 … %s"
              % (i, len(cand), thinned, max(worst, 0.0), ng, mark))
        ng_total += ng

    print("判定: %s" % ("合格（空気の通り道は空いている）" if ng_total == 0
                        else "不合格（%d 点が空洞側に置かれている）" % ng_total))
    return 0 if ng_total == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
