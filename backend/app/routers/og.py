"""Open Graph meta tag endpoint for link previews.

/@z/lat/lon/bearing/pitch → index.html にOGタグを注入して返す
ブラウザ: SPAが動いてURLから位置を復元
SNSボット: OGタグを読んでプレビュー表示
"""

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

router = APIRouter()

def _get_index_html() -> str:
    p = Path("/app/static/index.html")
    if p.exists():
        return p.read_text()
    return "<!DOCTYPE html><html><head></head><body>GeoScope</body></html>"


@router.get("/@{z}/{lat}/{lon}/{bearing}/{pitch}", response_class=HTMLResponse)
@router.get("/@{z}/{lat}/{lon}", response_class=HTMLResponse)
async def og_page(
    request: Request, z: float, lat: float, lon: float,
    bearing: float = 0, pitch: float = 60,
):
    zi = max(1, min(16, int(z)))
    lat = max(-85, min(85, lat))
    lon = max(-180, min(180, lon))

    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("host", request.url.netloc)
    base_url = f"{proto}://{host}"

    title = f"GeoScope — {lat:.4f}, {lon:.4f} (z{zi})"
    description = "GeoScope — 赤色立体地図で日本の地形を探索"
    image_url = f"{base_url}/tiles/preview/{zi}/{lat}/{lon}.png"
    page_url = f"{base_url}/@{z}/{lat}/{lon}/{bearing}/{pitch}"

    og_tags = f"""<meta property="og:type" content="website">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:image" content="{image_url}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="{page_url}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{description}">
<meta name="twitter:image" content="{image_url}">"""

    html = _get_index_html()
    html = html.replace("<head>", f"<head>\n{og_tags}", 1)
    html = html.replace("<title>GeoScope", f"<title>{title} | GeoScope", 1)
    return HTMLResponse(content=html)
