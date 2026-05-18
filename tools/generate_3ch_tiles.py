#!/usr/bin/env python3
"""DEM → 3チャネル画像生成

ch0: multi-direction hillshade (平均)
ch1: slope (傾斜)
ch2: curvature (ラプラシアン、凸面=明)
"""

import math
import numpy as np
import cv2
from _dem import decode_dem, TILE_PX


def multi_hillshade(filled, cell_size=1.0):
    """4方向のヒルシェードを平均"""
    dy, dx = np.gradient(filled, cell_size)
    slope = np.arctan(np.sqrt(dx**2 + dy**2))
    aspect = np.arctan2(-dy, dx)
    alt = math.radians(45)

    shades = []
    for az_deg in [0, 90, 180, 270]:
        az = math.radians(az_deg)
        shade = np.clip(
            math.sin(alt) * np.cos(slope) +
            math.cos(alt) * np.sin(slope) * np.cos(az - aspect), 0, 1)
        shades.append(shade)
    return np.mean(shades, axis=0)


def compute_slope(filled, cell_size=1.0):
    """傾斜角 (0-1に正規化)"""
    dy, dx = np.gradient(filled, cell_size)
    slope = np.arctan(np.sqrt(dx**2 + dy**2))
    return np.clip(slope / (math.pi / 4), 0, 1)  # 45°で1.0


def compute_curvature(filled, ksize=31):
    """ラプラシアン曲率。凸面(ドーム)が明るい。"""
    smoothed = cv2.GaussianBlur(filled, (ksize, ksize), 0)
    lap = cv2.Laplacian(smoothed, cv2.CV_64F, ksize=5)
    # 負のラプラシアン = 凸面 → 正に反転
    neg_lap = -lap
    # 標準偏差で正規化して0-1にクリップ
    std = max(np.std(neg_lap), 0.01)
    normalized = (neg_lap - np.mean(neg_lap)) / (3 * std) * 0.5 + 0.5
    return np.clip(normalized, 0, 1)


def dem_to_3ch(elev):
    """DEM標高データ → 3チャネル uint8画像 (H, W, 3)"""
    filled = elev.copy()
    mean_val = np.nanmean(elev) if not np.isnan(elev).all() else 0
    filled[np.isnan(filled)] = mean_val

    ch0 = multi_hillshade(filled)
    ch1 = compute_slope(filled)
    ch2 = compute_curvature(filled)

    img = np.stack([ch0, ch1, ch2], axis=2)
    return (img * 255).astype(np.uint8)


def tile_to_3ch(tile_path):
    """タイルファイル → 3ch画像"""
    elev = decode_dem(tile_path.read_bytes())
    valid = elev[~np.isnan(elev)]
    if len(valid) < TILE_PX * TILE_PX * 0.3:
        return None
    return dem_to_3ch(elev)


if __name__ == "__main__":
    from pathlib import Path
    import sys

    # テスト: 1タイルを変換して保存
    tiles_dir = Path("qchizu_dem1a_tiles")
    scan_dir = tiles_dir / "16"
    x_dir = sorted(scan_dir.iterdir())[100]
    x = int(x_dir.name)
    f = sorted(x_dir.glob("*.webp"))[0]
    y = int(f.stem)

    img = tile_to_3ch(f)
    if img is not None:
        cv2.imwrite("/tmp/test_3ch.png", img)
        print(f"Saved /tmp/test_3ch.png: {img.shape} {img.dtype}")
        print(f"ch0 (hillshade): mean={img[:,:,0].mean():.1f}")
        print(f"ch1 (slope):     mean={img[:,:,1].mean():.1f}")
        print(f"ch2 (curvature): mean={img[:,:,2].mean():.1f}")

    # 既知古墳のテスト画像も生成
    from known_kofun import KNOWN_KOFUN

    for name, lat, lon, length in KNOWN_KOFUN[:5]:
        n = 2**16
        tx = int((lon + 180) / 360 * n)
        lat_rad = math.radians(lat)
        ty = int((1 - math.log(math.tan(lat_rad) + 1/math.cos(lat_rad)) / math.pi) / 2 * n)
        tile_path = tiles_dir / f"16/{tx}/{ty}.webp"
        if not tile_path.exists():
            continue
        img = tile_to_3ch(tile_path)
        if img is not None:
            cv2.imwrite(f"/tmp/test_3ch_{name}.png", img)
            print(f"Saved: {name}")
