"""埋め込んだ笛の印刷向きが、実機で確かめた範囲に入っているかを判定する。

日用品に笛を埋め込むとき、笛をどの向きに寝かせるか（＝窓がどちらを向くか）で
鳴る・鳴らないが決まる。2026年7月27日から28日にかけて実機で掃引した結果、
使える範囲がはっきりしたので、それを機械的に確かめられるようにした。

判定のもとになった実機の結果（すべてPLA・0.08mm・careful thinwall）。

  横置き（笛の長軸が水平）で、窓が真上を向く向きを0度とし、長軸まわりに回した角度
    0度                実績多数。カード・スプール・コームはすべてこの向き
    プラスマイナス45度   2026-07-28 鳴った
    プラスマイナス90度   2026-07-27 鳴った。音程差はマイナス2.4セント以内
    プラスマイナス135度  2026-07-28 鳴った
    180度（窓が真下）    2026-07-28 [* 鳴らない]。天井が正しく被覆されず窓の造形も不安定
  縦置き（長軸が垂直）
    吸込口が下   条件つきで鳴る。低音は安定するが狙いよりプラス95セント、高音は基音が定まらない
    吸込口が上   [* 鳴らない]。吸込口から窓への風道が埋まる

したがって、[* 横置きで窓の角度がマイナス135度からプラス135度なら安心して使える]。
これは360度のうち270度にあたる。残る90度（真下まわり）と縦置きは避けるか、
避けられないなら実機で確かめてから使う。

使い方は2通り。

  from orient_check import check_orientation
  r = check_orientation(R)              # 笛に掛けた3x3または4x4の回転
  r = check_orientation(window_normal=n, long_axis=a)   # 世界座標の向きを直接渡す
  print(r.verdict, r.angle_deg, r.message)

コマンドからも使える。
  python3 fue/orient_check.py --window-normal 0 1 0 --long-axis 1 0 0
"""
from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, field

import numpy as np

# native姿勢（mini10.uniform_flute が返す向き）
NATIVE_WINDOW = np.array([0.0, 0.0, 1.0])   # 窓の向き
NATIVE_LONG = np.array([1.0, 0.0, 0.0])     # 長軸（吸込口 x=0 から足へ）

SAFE_DEG = 135.0        # 横置きでこの角度までは実機で鳴った
TILT_FLAT_DEG = 20.0    # 長軸がこれ以下の傾きなら「横置き」とみなす
TILT_UP_DEG = 70.0      # 長軸がこれ以上の傾きなら「縦置き」とみなす


@dataclass
class Result:
    verdict: str          # "ok" / "ng" / "caution" / "unknown"
    angle_deg: float      # 窓の角度（横置きのとき。0度＝真上、正負は長軸まわり）
    tilt_deg: float       # 長軸の水平からの傾き（0度＝横置き、90度＝縦置き）
    mouth: str            # 縦置きのときの吸込口の向き "up"/"down"/""
    message: str
    detail: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.verdict == "ok"


def _unit_rows(a):
    a = np.asarray(a, dtype=float)
    return a / np.linalg.norm(a, axis=1, keepdims=True)


def _unit(v):
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    if n < 1e-12:
        raise ValueError("零ベクトルは向きとして使えない")
    return v / n


def check_orientation(R=None, window_normal=None, long_axis=None) -> Result:
    """笛の向きを判定する。

    R を渡すと native の窓と長軸に掛けて世界座標の向きを出す。
    window_normal と long_axis を直接渡してもよい。
    """
    if R is not None:
        M = np.asarray(R, dtype=float)
        if M.shape == (4, 4):
            M = M[:3, :3]
        if M.shape != (3, 3):
            raise ValueError("R は3x3か4x4で渡す")
        w = _unit(M @ NATIVE_WINDOW)
        a = _unit(M @ NATIVE_LONG)
    else:
        if window_normal is None or long_axis is None:
            raise ValueError("R か、window_normal と long_axis の両方が要る")
        w = _unit(window_normal)
        a = _unit(long_axis)

    if abs(float(np.dot(w, a))) > 0.2:
        raise ValueError("窓の向きと長軸が直交していない。渡し方を確かめること")

    tilt = math.degrees(math.asin(min(1.0, abs(float(a[2])))))   # 長軸の水平からの傾き

    # 長軸まわりの角度。長軸に直交する平面で、真上(+z)を0度として測る。
    up = np.array([0.0, 0.0, 1.0])
    up_perp = up - float(np.dot(up, a)) * a
    if np.linalg.norm(up_perp) < 1e-9:      # 長軸が真上（＝縦置き）
        angle = float("nan")
    else:
        up_perp = _unit(up_perp)
        ref = _unit(np.cross(a, up_perp))   # 角度の符号を決める軸
        angle = math.degrees(math.atan2(float(np.dot(w, ref)), float(np.dot(w, up_perp))))

    mouth = ""
    if tilt >= TILT_UP_DEG:
        # 長軸が立っている。吸込口は長軸の逆側（x=0の端）にある。
        mouth = "up" if a[2] < 0 else "down"

    detail = dict(window_normal=[round(float(x), 4) for x in w],
                  long_axis=[round(float(x), 4) for x in a])

    if tilt <= TILT_FLAT_DEG:
        if abs(angle) <= SAFE_DEG:
            return Result("ok", angle, tilt, mouth,
                          "横置き・窓の角度 %+.1f度。実機で確かめた範囲（±%.0f度）の中で、"
                          "安心して使える。" % (angle, SAFE_DEG), detail)
        return Result("ng", angle, tilt, mouth,
                      "横置き・窓の角度 %+.1f度。[NG] 真下まわり（±%.0f度を超える範囲）は"
                      "2026-07-28に実機で鳴らなかった。天井が被覆されず窓の造形も崩れる。"
                      "窓を上寄りへ回すこと。" % (angle, SAFE_DEG), detail)

    if tilt >= TILT_UP_DEG:
        if mouth == "down":
            return Result("caution", angle, tilt, mouth,
                          "縦置き・吸込口が下（長軸の傾き %.1f度）。[要注意] 鳴ることは"
                          "確かめたが、低音は狙いより約+95セントずれ、高音は基音が定まらない。"
                          "復号に使うなら実機で1本ずつ確かめること。" % tilt, detail)
        return Result("ng", angle, tilt, mouth,
                      "縦置き・吸込口が上（長軸の傾き %.1f度）。[NG] 吸込口から窓への"
                      "風道が埋まって息が入らない。2026-07-28に実機で確認。" % tilt, detail)

    return Result("unknown", angle, tilt, mouth,
                  "長軸が水平からも垂直からも外れている（傾き %.1f度）。[未検証] "
                  "この置き方は実機で確かめていない。横置き（傾き%.0f度以下）に"
                  "寄せるか、試作して確かめること。" % (tilt, TILT_FLAT_DEG), detail)


def check_many(items) -> list:
    """(名前, 引数dict) の並びをまとめて判定する。戻り値は (名前, Result) の並び。"""
    out = []
    for name, kw in items:
        try:
            out.append((name, check_orientation(**kw)))
        except Exception as e:                                   # noqa: BLE001
            out.append((name, Result("unknown", float("nan"), float("nan"), "",
                                     "判定できない: %s" % e)))
    return out


def report(results, prefix="  ") -> bool:
    """判定を人が読める形で出す。全部okならTrueを返す。"""
    mark = {"ok": "OK ", "ng": "NG ", "caution": "注意", "unknown": "不明"}
    all_ok = True
    for name, r in results:
        if r.verdict != "ok":
            all_ok = False
        print("%s[%s] %-16s %s" % (prefix, mark[r.verdict], name, r.message))
    return all_ok


def main(argv=None):
    ap = argparse.ArgumentParser(description="埋め込んだ笛の印刷向きを確かめる")
    ap.add_argument("--window-normal", nargs=3, type=float, metavar=("X", "Y", "Z"),
                    help="世界座標での窓の向き")
    ap.add_argument("--long-axis", nargs=3, type=float, metavar=("X", "Y", "Z"),
                    help="世界座標での長軸の向き（吸込口から足へ）")
    ap.add_argument("--angle", type=float,
                    help="横置きで、窓が真上を0度として長軸まわりに回した角度")
    a = ap.parse_args(argv)

    if a.angle is not None:
        t = math.radians(a.angle)
        kw = dict(window_normal=[0, -math.sin(t), math.cos(t)], long_axis=[1, 0, 0])
    elif a.window_normal and a.long_axis:
        kw = dict(window_normal=a.window_normal, long_axis=a.long_axis)
    else:
        ap.error("--angle か、--window-normal と --long-axis の両方を指定する")
    r = check_orientation(**kw)
    print(r.message)
    print("  窓の角度 %.1f度 / 長軸の傾き %.1f度 / %s" % (r.angle_deg, r.tilt_deg, r.detail))
    return 0 if r.verdict == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())


# ---- メッシュから分かることだけを見る（既存の成果物を監査するため） ------
def check_mesh_tilt(mesh) -> Result:
    """笛1本のメッシュから[* 長軸の傾きだけ]を割り出して判定する。

    メッシュから窓の向きまで復元しようとして失敗した経緯がある。窓は長軸の
    ごく一部（吸込口から12から16.5mm）にしかないので、ボアの中から光線を飛ばして
    「抜ける向き」を探す方法では、抜けない点が大多数になって当たりが定まらない。
    実際に0度の笛を+48度と誤って復元した。そこで[* 窓の角度はメッシュから推定しない]。

    長軸の傾きは主成分から確実に取れる（笛は62mm×7mm×4mmで細長い）。これだけでも
    「縦置きになっていないか」という、いちばん危ない取り違えは捕まえられる。
    窓の角度まで確かめたいときは、配置したコードが持つ回転行列を
    check_orientation(R=...) へ渡すこと。
    """
    v = np.asarray(mesh.vertices, dtype=float)
    _, _, vt = np.linalg.svd(v - v.mean(axis=0), full_matrices=False)
    axis = _unit(vt[0])
    tilt = math.degrees(math.asin(min(1.0, abs(float(axis[2])))))
    detail = dict(long_axis=[round(float(x), 4) for x in axis])
    if tilt <= TILT_FLAT_DEG:
        return Result("unknown", float("nan"), tilt, "",
                      "横置き（長軸の傾き %.1f度）。ここまでは良い。ただし[* 窓の角度は"
                      "メッシュから判定できない]ので、配置した回転行列を "
                      "check_orientation(R=...) へ渡して確かめること。" % tilt, detail)
    if tilt >= TILT_UP_DEG:
        return Result("ng", float("nan"), tilt, "",
                      "縦置き（長軸の傾き %.1f度）。[NG] 吸込口が上なら風道が埋まって"
                      "鳴らない。下向きでも音程が狂う。横置きへ寝かせ直すこと。" % tilt, detail)
    return Result("unknown", float("nan"), tilt, "",
                  "長軸が水平からも垂直からも外れている（傾き %.1f度）。[未検証]" % tilt,
                  detail)
