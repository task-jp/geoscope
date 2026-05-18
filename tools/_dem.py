"""DEM タイル (WebP) のデコード共通関数

GeoScope の DEM タイルは Q地図 / 国土地理院互換のエンコード:
    h = (R * 65536 + G * 256 + B) * 0.01  [m]
    x == 2**23 は無効値 (NaN)
    x  > 2**23 は負の標高 (海面下) — x - 2**24 してから 0.01 倍
"""

import io

import numpy as np
from PIL import Image

TILE_PX = 512


def decode_dem(data: bytes) -> np.ndarray:
    """WebP バイト列から (TILE_PX, TILE_PX) の float64 標高配列を返す。"""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    arr = np.array(img, dtype=np.float64)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    x = r * 65536 + g * 256 + b
    return np.where(x == 2**23, np.nan, np.where(x > 2**23, (x - 2**24) * 0.01, x * 0.01))
