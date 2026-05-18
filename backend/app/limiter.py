"""共有 slowapi Limiter インスタンス. ルータから import して使う.

key_func=get_remote_address は X-Forwarded-For を見るので nginx 経由でも実IP取得。
"""

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(
    key_func=get_remote_address,
    default_limits=["300/minute"],
)
