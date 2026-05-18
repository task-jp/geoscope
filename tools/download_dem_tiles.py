#!/usr/bin/env python3
"""国土地理院 DEM標高タイル ダウンロードスクリプト

指定した範囲・ズームレベルのDEM標高タイル(PNG)をダウンロードする。
DEM1A → DEM5A → DEM5B → DEM5C → DEM10B → DEMGM の順にフォールバック。
"""

import argparse
import json
import math
import sys
import time
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from tqdm import tqdm

DEM_SOURCES = [
    ("dem1a", "https://cyberjapandata.gsi.go.jp/xyz/dem1a_png/{z}/{x}/{y}.png", 9, 17),
    ("dem5a", "https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png", 9, 15),
    ("dem5b", "https://cyberjapandata.gsi.go.jp/xyz/dem5b_png/{z}/{x}/{y}.png", 9, 15),
    ("dem5c", "https://cyberjapandata.gsi.go.jp/xyz/dem5c_png/{z}/{x}/{y}.png", 9, 15),
    ("dem10b", "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png", 9, 14),
    ("demgm", "https://cyberjapandata.gsi.go.jp/xyz/demgm_png/{z}/{x}/{y}.png", 0, 8),
]


def lat_lon_to_tile(lat: float, lon: float, z: int) -> tuple[int, int]:
    """WGS84 緯度経度をタイル座標(x, y)に変換する。"""
    n = 2**z
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    x = max(0, min(n - 1, x))
    y = max(0, min(n - 1, y))
    return x, y


def bbox_to_tile_range(south: float, west: float, north: float, east: float, z: int):
    """バウンディングボックスからタイル範囲を計算する。"""
    x_min, y_max = lat_lon_to_tile(south, west, z)  # 南西 → y大
    x_max, y_min = lat_lon_to_tile(north, east, z)   # 北東 → y小
    if x_min > x_max:
        x_min, x_max = x_max, x_min
    if y_min > y_max:
        y_min, y_max = y_max, y_min
    return x_min, y_min, x_max, y_max


class RateLimiter:
    def __init__(self, min_interval: float):
        self.min_interval = min_interval
        self.last_request = 0.0

    def wait(self):
        elapsed = time.monotonic() - self.last_request
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self.last_request = time.monotonic()


def create_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(total=3, backoff_factor=1, status_forcelist=[500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.headers["User-Agent"] = "qchizu-dem-downloader/1.0"
    return session


def download_tile(
    session: requests.Session,
    z: int, x: int, y: int,
    sources: list,
    output_dir: Path,
    rate_limiter: RateLimiter,
) -> tuple[str, str]:
    """タイルをダウンロードする。(status, source_name) を返す。"""
    output_path = output_dir / f"{z}/{x}/{y}.png"
    if output_path.exists() and output_path.stat().st_size > 0:
        return "skipped", ""

    for name, url_template, _, _ in sources:
        url = url_template.format(z=z, x=x, y=y)
        rate_limiter.wait()
        try:
            resp = session.get(url, timeout=30)
        except requests.RequestException:
            continue
        if resp.status_code == 200:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = output_path.with_suffix(".tmp")
            tmp_path.write_bytes(resp.content)
            tmp_path.rename(output_path)
            return "ok", name
        if resp.status_code == 429:
            time.sleep(5)
        # 404 or other errors → try next source

    return "not_found", ""


def main():
    parser = argparse.ArgumentParser(
        description="国土地理院 DEM標高タイル ダウンローダー",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
使用例:
  # 名取市付近 z=17 (DEM1A)
  %(prog)s --bbox 38.15 140.85 38.20 140.95 --zoom 17

  # 東京都心 z=14
  %(prog)s --bbox 35.65 139.70 35.70 139.80 --zoom 14

  # DEM5Aのみ指定
  %(prog)s --bbox 35.0 135.0 36.0 136.0 --zoom 15 --sources dem5a""",
    )
    parser.add_argument("--bbox", nargs=4, type=float, required=True,
                        metavar=("SOUTH", "WEST", "NORTH", "EAST"),
                        help="バウンディングボックス (緯度経度, WGS84)")
    parser.add_argument("--zoom", "-z", type=int, required=True,
                        help="ズームレベル (0-17)")
    parser.add_argument("--output-dir", "-o", type=Path, default=Path("tiles"),
                        help="出力ディレクトリ (default: ./tiles)")
    parser.add_argument("--rate-limit", type=float, default=0.1,
                        help="リクエスト間隔 秒 (default: 0.1)")
    parser.add_argument("--sources", nargs="+", default=None,
                        help="使用するDEMソース (default: 全て)")
    parser.add_argument("--dry-run", action="store_true",
                        help="タイル数を表示して終了")
    args = parser.parse_args()

    south, west, north, east = args.bbox
    z = args.zoom

    if south >= north:
        print("エラー: SOUTH は NORTH より小さくしてください", file=sys.stderr)
        sys.exit(1)
    if west >= east:
        print("エラー: WEST は EAST より小さくしてください", file=sys.stderr)
        sys.exit(1)
    if not 0 <= z <= 17:
        print("エラー: ズームレベルは 0-17 の範囲で指定してください", file=sys.stderr)
        sys.exit(1)

    # ズームレベルに対応するソースをフィルタ
    if args.sources:
        source_names = set(args.sources)
        sources = [(n, u, mn, mx) for n, u, mn, mx in DEM_SOURCES if n in source_names]
        if not sources:
            print(f"エラー: 指定されたソースが見つかりません: {args.sources}", file=sys.stderr)
            sys.exit(1)
    else:
        sources = DEM_SOURCES

    available = [(n, u, mn, mx) for n, u, mn, mx in sources if mn <= z <= mx]
    if not available:
        names = [f"{n} (z={mn}-{mx})" for n, _, mn, mx in sources]
        print(f"エラー: z={z} に対応するDEMソースがありません", file=sys.stderr)
        print(f"利用可能: {', '.join(names)}", file=sys.stderr)
        sys.exit(1)

    x_min, y_min, x_max, y_max = bbox_to_tile_range(south, west, north, east, z)
    total = (x_max - x_min + 1) * (y_max - y_min + 1)

    print(f"ズームレベル: {z}")
    print(f"DEMソース: {' → '.join(n for n, _, _, _ in available)}")
    print(f"タイル範囲: x=[{x_min}..{x_max}], y=[{y_min}..{y_max}]")
    print(f"タイル数: {total:,}")

    if total > 10000:
        print(f"警告: タイル数が多いです ({total:,} tiles)", file=sys.stderr)

    if args.dry_run:
        return

    session = create_session()
    limiter = RateLimiter(args.rate_limit)
    stats = {"ok": 0, "skipped": 0, "not_found": 0}
    source_counts: dict[str, int] = {}

    tiles = [(x, y) for y in range(y_min, y_max + 1) for x in range(x_min, x_max + 1)]

    try:
        for x, y in tqdm(tiles, desc="Downloading", unit="tile"):
            status, source_name = download_tile(session, z, x, y, available, args.output_dir, limiter)
            stats[status] += 1
            if source_name:
                source_counts[source_name] = source_counts.get(source_name, 0) + 1
    except KeyboardInterrupt:
        print("\n中断しました。再実行で続きからダウンロードできます。")

    print(f"\n--- 結果 ---")
    print(f"ダウンロード: {stats['ok']:,}")
    if source_counts:
        for name, count in source_counts.items():
            print(f"  {name}: {count:,}")
    print(f"スキップ (既存): {stats['skipped']:,}")
    print(f"データなし: {stats['not_found']:,}")

    # メタデータ保存
    meta = {
        "bbox": {"south": south, "west": west, "north": north, "east": east},
        "zoom": z,
        "sources": [n for n, _, _, _ in available],
        "stats": stats,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    meta_path = args.output_dir / "metadata.json"
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
