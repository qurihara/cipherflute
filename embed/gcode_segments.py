"""スライス済み3mfの実gcodeで、空洞(ボア/窓)が充填されていないかを確認する。

要点2つ（過去に両方踏んだ）:
  1) 距離は押出の「端点」ではなく「線分」で測る。ソリッドインフィルは長い直線1本=端点2個なので、
     端点距離だと線の途中が「遠い=空洞」と誤判定される。
  2) STL座標→ベッド座標の変換は 3mf の build item transform を読む。arrange は毎回同じ向きに
     置くとは限らない（+90°と-90°が入れ替わる。bboxが同じなので気づけない）。
"""
import re, sys, zipfile
import numpy as np
from collections import defaultdict


def bed_transform(three_mf):
    """3mf の build item transform を読み、STL座標→ベッド座標の関数を返す。"""
    with zipfile.ZipFile(three_mf) as z:
        xml = z.read('3D/3dmodel.model').decode('utf8', 'ignore')
    ts = re.findall(r'transform="([^"]*)"', xml)
    m = [float(v) for v in ts[-1].split()]          # 最後 = build item
    def f(x, y, z=0.0):
        bx = x*m[0] + y*m[3] + z*m[6] + m[9]
        by = x*m[1] + y*m[4] + z*m[7] + m[10]
        return bx, by
    return f, m


def load_segments(gcode_path):
    """z -> 押出線分[(x0,y0,x1,y1)] を返す。"""
    rx = re.compile(r'([XYZE])(-?\d*\.?\d+)')
    segs = defaultdict(list)
    x = y = z = None
    for line in open(gcode_path, errors='ignore'):
        s = line.split(';')[0].strip()
        if not (s.startswith('G1') or s.startswith('G0')):
            continue
        d = dict((k, float(v)) for k, v in rx.findall(s))
        nx, ny = d.get('X', x), d.get('Y', y)
        if 'Z' in d:
            z = d['Z']
        e = d.get('E')
        if e is not None and e > 0 and None not in (x, y, nx, ny, z) and (nx != x or ny != y):
            segs[round(z, 2)].append((x, y, nx, ny))
        x, y = nx, ny
    return segs


def dist_to_segments(px, py, S):
    x0, y0, x1, y1 = S[:, 0], S[:, 1], S[:, 2], S[:, 3]
    dx, dy = x1 - x0, y1 - y0
    L2 = dx * dx + dy * dy
    L2[L2 == 0] = 1e-9
    t = np.clip(((px - x0) * dx + (py - y0) * dy) / L2, 0, 1)
    return np.hypot(px - (x0 + t * dx), py - (y0 + t * dy)).min()
