"""笛をホストモデル(STL/3mf)に「鳴るように」埋め込む汎用ヘルパ。

核心のノウハウ＝ホストから笛の外形分のポケットを boolean で彫り抜いてから笛を戻す。
そのままホスト材料に重ねて union/concatenate すると、ホストの中身がボア・窓・風道を
埋めてしまい笛が鳴らない。凸包(=中身を詰めた外形ソリッド)でポケットを彫れば、その部分の
ホスト材料が消えるので、笛のボア(床の上の空洞)・窓・吸込口は中空/開口のまま残る。

trimesh の boolean は engine="manifold" を使う。実行は mesh_venv の python
(/Users/kurihara/Desktop/claude_work/mesh_venv/bin/python) で。
"""
import numpy as np
import trimesh
from trimesh import transformations as tf


# 笛(mini10.flute)の native 向き: 窓=+z, 床=z=0, 吸込口=x=0端面, 長さ=+x, 最小角=原点。
# 埋め込み先の面に応じて笛の向きを作る回転行列(det=+1・正しい回転)。
# 窓を +X(外面側)へ向ける例（外面が空気に開いているとき）:
M_WINDOW_PLUS_X = np.array([[0, 0, 1], [-1, 0, 0], [0, -1, 0]], float)
# 窓を -X(内面側)へ向ける例（外面にハニカム等の障害物があり内側が空気のとき。スプールで採用）:
M_WINDOW_MINUS_X = np.array([[0, 0, -1], [-1, 0, 0], [0, 1, 0]], float)


def carve_and_place(host, placed_flutes, engine="manifold"):
    """host から各笛の凸包分のポケットを彫り抜き、笛(壁)を戻して1メッシュに結合する。
    これで笛のボア・窓・吸込口がホスト材料で埋まらない。
    戻り値 (combined_mesh, carved_host)。"""
    carved = host
    for f in placed_flutes:
        carved = carved.difference(f.convex_hull, engine=engine)
    combined = trimesh.util.concatenate([carved] + list(placed_flutes))
    return combined, carved


def bore_hollow(result_mesh, sample_points):
    """ボア域の点が result の外(=中空)かを返す。全て True なら埋まっていない。
    sample_points は「床の少し上・笛の内部(ボア)にあたる座標」を数点。"""
    inside = result_mesh.contains(np.asarray(sample_points, float))
    return [not bool(b) for b in inside]


def opening_is_air(mesh, point_just_outside):
    """窓/吸込口のすぐ外側の点が空気(=メッシュの外)かを返す。True なら露出している。"""
    return not bool(mesh.contains(np.asarray([point_just_outside], float))[0])


def export_multiobj(host, placed_flutes, out_path, host_name="host", flute_names=None):
    """ホストと各笛を別オブジェクトにした Scene として書き出す。
    スライサでホスト=粗い層(0.20)・笛=可変レイヤー高さで細層(0.08)+careful thinwall壁、
    のように「笛だけ別設定」で刷るために別オブジェクトにしておく。"""
    sc = trimesh.Scene()
    sc.add_geometry(host, geom_name=host_name)
    for i, f in enumerate(placed_flutes):
        nm = flute_names[i] if flute_names else "flute%d" % (i + 1)
        sc.add_geometry(f, geom_name=nm)
    sc.export(out_path)
    return out_path


def material_depth(host, outer_point, inward_dir, max_depth=16.0, step=0.3):
    """ホストの外面のある点から内側へ、連続して材料がある厚み[mm]を返す。
    中実か肉抜き(スポーク等)かの切り分けに使う。0 なら開口/肉抜き。"""
    outer_point = np.asarray(outer_point, float)
    inward_dir = np.asarray(inward_dir, float)
    inward_dir = inward_dir / np.linalg.norm(inward_dir)
    depth = 0.0
    for d in np.arange(step, max_depth + 1e-9, step):
        if host.contains(np.array([outer_point + inward_dir * d]))[0]:
            depth = d
        elif depth > 0:
            break
    return depth
