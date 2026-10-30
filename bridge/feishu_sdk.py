"""飞书消息通道（官方 SDK 版）。

和老的「弹飞书到前台 → 你复制 → 读剪贴板」相比，这条路走的是开放平台接口，
拿到的是一条条结构化消息：发送人、精确时间、消息 ID、消息类型，不需要窗口在前台。

三件事都在这一个文件里：
  1. 建一个自建应用（扫码确认，scope 已预填，不用去后台点选）
  2. 用设备码模式拿用户授权（拿一次 access_token + refresh_token，之后自动续）
  3. 按群名和时间范围拉消息，转成 notice_bridge 认识的结构

命令行用法：
    python feishu_sdk.py register          # 建应用，扫二维码确认
    python feishu_sdk.py login             # 用户授权
    python feishu_sdk.py status            # 看当前登录态
    python feishu_sdk.py chats             # 列出我能看到的群
    python feishu_sdk.py test --chat 年级群 --days 3

授权信息存在同目录的 feishu_auth.json，不要提交到任何仓库。
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

# 注意：这里**不**导入 lark_oapi。
# 实测 import lark_oapi 要 40 秒（包初始化把全部业务域都拉进来了），
# 而它对常驻服务只有一个用途——建应用。所以：
#   register（一次性命令）→ 函数里才 import SDK；
#   拉群/拉消息（常驻路径）→ 直接用 HTTP 打 OpenAPI，几十毫秒。
# 另外在 HTTP 请求线程里首次 import lark_oapi 会死锁（import 锁），这也是不走 SDK 的原因之一。
SDK_AVAILABLE = importlib.util.find_spec("lark_oapi") is not None

AUTH_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "feishu_auth.json")
ACCOUNTS_BASE = "https://accounts.feishu.cn"
OPENAPI_BASE = "https://open.feishu.cn"

# 读群消息所需的最小权限。scope 决定「允不允许调这个接口」，身份决定「以谁的视角看数据」。
# im:message:readonly 只够看「消息本身」，真正拉群历史还要 group_msg:get_as_user（用户身份读群消息），
# 只给前两个会返回 230027 Lack of necessary permissions。
DEFAULT_SCOPES = [
    "im:message:readonly",
    "im:chat:read",
    "im:message.group_msg:get_as_user",
]

DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"


class NotLoggedIn(RuntimeError):
    """还没授权，或者授权过期了。

    用普通异常而不是 SystemExit：这个模块会被 HTTP 服务里的线程调用，
    SystemExit 在线程里是「静默退出」，请求会一直挂着不返回。
    """


class FeishuError(RuntimeError):
    """接口调用失败（权限不足、群不存在、限流等）。"""


# ------------------------------- 本地存储 -------------------------------


def load_auth() -> dict:
    try:
        with open(AUTH_PATH, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def save_auth(data: dict) -> None:
    merged = {**load_auth(), **data}
    tmp = AUTH_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(merged, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, AUTH_PATH)
    try:
        os.chmod(AUTH_PATH, 0o600)
    except OSError:
        pass


# ------------------------------- HTTP -------------------------------


def _post(url: str, payload: dict, token: str | None = None) -> dict:
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return json.loads(raw)
        except ValueError:
            return {"error": "http_error", "error_description": raw[:300]}


# ------------------------------- 第一步：建应用 -------------------------------


def register_app() -> dict:
    """扫码建一个自建应用，返回 client_id / client_secret。

    这是 SDK 自带的一键注册：背后是设备码流程的 action=begin/poll，
    用户扫一次码确认，应用就建好了，scope 通过 addons 预填进确认页。
    """
    if not SDK_AVAILABLE:
        raise FeishuError("没装 lark-oapi：pip install lark-oapi（只有建应用这一步需要它）")
    # 只有这条一次性命令会 import SDK；常驻服务不碰它（导入要 40 秒，见文件头说明）
    import lark_oapi as lark

    existing = load_auth()
    if existing.get("client_id") and existing.get("client_secret"):
        # 已经有应用了，还走 register 只会再建一个，直接换 app_id 更新配置。
        print(f"已有应用 {existing['client_id']}，只更新权限配置。")
        result = lark.register_app(
            on_qr_code=lambda info: _print_url(info["url"], info.get("expire_in")),
            addons={"scopes": {"user": DEFAULT_SCOPES}},
            app_id=existing["client_id"],
        )
        return {"client_id": existing["client_id"], "client_secret": existing["client_secret"], **result}

    result = lark.register_app(
        on_qr_code=lambda info: _print_url(info["url"], info.get("expire_in")),
        app_preset={
            "name": "{user} 的信息管家",
            "desc": "本地个人助手，只读取你自己能看到的群消息",
        },
        addons={"scopes": {"user": DEFAULT_SCOPES}},
        create_only=True,
    )
    save_auth({"client_id": result["client_id"], "client_secret": result["client_secret"]})
    print(f"\n应用已创建：{result['client_id']}")
    return result


def _print_url(url: str, expire_in: int | None = None) -> None:
    minutes = f"（{expire_in // 60} 分钟内有效）" if expire_in else ""
    print("\n" + "=" * 60)
    print(f"请用飞书扫描下面的二维码，或直接在浏览器打开链接{minutes}：")
    print(url)
    print("=" * 60 + "\n", flush=True)
    _try_qrcode(url)


def _try_qrcode(url: str) -> None:
    """有 qrcode 库就顺手把二维码打到终端；没有就只给链接，不影响流程。"""
    try:
        import qrcode  # type: ignore

        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make()
        qr.print_ascii(invert=True)
    except Exception:
        pass


# ------------------------------- 第二步：用户授权 -------------------------------


def device_login(on_url=None) -> dict:
    """设备码模式拿用户授权，不需要本地回调端口，也不用改应用的 redirect_uri。

    on_url 用来把验证链接交给调用方（服务模式下面板要把它显示出来）；
    不传就直接打到终端。
    """
    auth = load_auth()
    if not auth.get("client_id"):
        raise SystemExit("还没有应用，先跑 register")

    response = _post(
        f"{ACCOUNTS_BASE}/oauth/v1/device_authorization",
        {
            "client_id": auth["client_id"],
            # 这个接口必须带 secret，只给 client_id 会返回 "The auth method is not supported"
            "client_secret": auth["client_secret"],
            "scope": " ".join(DEFAULT_SCOPES),
        },
    )
    if response.get("error"):
        raise SystemExit(f"申请设备码失败：{response.get('error_description') or response}")

    device_code = response["device_code"]
    interval = int(response.get("interval", 5))
    expires_in = int(response.get("expires_in", 600))
    url = response.get("verification_uri_complete") or response.get("verification_uri") or ""
    if on_url:
        on_url(url, expires_in)
    else:
        _print_url(url, expires_in)

    deadline = time.monotonic() + expires_in
    while time.monotonic() < deadline:
        time.sleep(interval)
        token = _post(
            f"{OPENAPI_BASE}/open-apis/authen/v2/oauth/token",
            {
                "grant_type": DEVICE_GRANT,
                "client_id": auth["client_id"],
                "client_secret": auth["client_secret"],
                "device_code": device_code,
            },
        )
        error = token.get("error")
        if not error:
            _store_token(token)
            print("授权成功。")
            return token
        if error == "authorization_pending":
            continue
        if error == "slow_down":
            interval += 5
            continue
        raise SystemExit(f"授权失败：{token.get('error_description') or error}")
    raise SystemExit("授权超时，重新跑 login")


def _store_token(token: dict) -> None:
    now = int(time.time())
    save_auth(
        {
            "access_token": token.get("access_token", ""),
            "refresh_token": token.get("refresh_token", ""),
            "expires_at": now + int(token.get("expires_in", 7200) or 7200),
            "refresh_expires_at": now + int(token.get("refresh_token_expires_in", 0) or 0),
            "scope": token.get("scope", ""),
        }
    )


def ensure_token() -> str:
    """返回可用的 user_access_token；快过期就先刷新。"""
    auth = load_auth()
    token = auth.get("access_token")
    if token and int(auth.get("expires_at", 0)) - 120 > time.time():
        return token

    if not auth.get("refresh_token"):
        raise NotLoggedIn("还没完成授权：点「扫码授权」确认一次（命令行里是 python bridge/feishu_sdk.py login）")

    response = _post(
        f"{OPENAPI_BASE}/open-apis/authen/v1/oidc/refresh_access_token",
        {
            "grant_type": "refresh_token",
            "client_id": auth["client_id"],
            "client_secret": auth["client_secret"],
            "refresh_token": auth["refresh_token"],
        },
    )
    if response.get("code") not in (None, 0) or response.get("error"):
        raise NotLoggedIn(
            f"刷新 token 失败：{response.get('msg') or response.get('error_description')}；重新跑 login"
        )
    data = response.get("data") or response
    _store_token(data)
    return data.get("access_token", "")


def _api_get(path: str, params: dict) -> dict:
    """带用户 token 打一次 OpenAPI GET，返回 data 部分。"""
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    request = urllib.request.Request(
        f"{OPENAPI_BASE}{path}?{query}",
        headers={
            "Authorization": f"Bearer {ensure_token()}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
        except ValueError:
            raise FeishuError(f"HTTP {error.code}: {raw[:200]}") from error
    except urllib.error.URLError as error:
        raise FeishuError(f"连不上飞书：{error.reason}") from error

    code = payload.get("code")
    if code not in (0, None):
        message = payload.get("msg") or ""
        if code == 230027:
            raise FeishuError(
                "缺权限：需要在应用里开通 im:message.group_msg:get_as_user，"
                f"并重新授权（{message}）"
            )
        raise FeishuError(f"飞书返回 {code}：{message}")
    return payload.get("data") or {}


def list_chats() -> list[dict]:
    """我能看到的群（机器人/用户所在会话）。"""
    found: list[dict] = []
    page_token = ""
    for _ in range(20):
        data = _api_get(
            "/open-apis/im/v1/chats",
            {"page_size": 100, "user_id_type": "open_id", "page_token": page_token},
        )
        for item in data.get("items") or []:
            found.append(
                {
                    "chat_id": item.get("chat_id", ""),
                    "name": item.get("name") or "",
                    "mode": item.get("chat_mode") or "",
                }
            )
        page_token = data.get("page_token") or ""
        if not data.get("has_more") or not page_token:
            break
    return found


def resolve_chat(name: str, chats: list[dict] | None = None) -> dict | None:
    """按群名找 chat_id：先精确匹配，再模糊匹配。"""
    items = chats if chats is not None else list_chats()
    exact = [item for item in items if item["name"] == name]
    if len(exact) == 1:
        return exact[0]
    fuzzy = [item for item in items if name in item["name"]]
    if len(fuzzy) == 1:
        return fuzzy[0]
    if len(fuzzy) > 1:
        names = "、".join(item["name"] for item in fuzzy[:5])
        print(f"「{name}」匹配到多个群：{names}，用更完整的名字再试")
        return None
    return None


def fetch_messages(chat_id: str, days: int = 1) -> list[dict]:
    """拉某个群最近 days 天的消息（含今天）。"""
    end = datetime.now()
    start = (end - timedelta(days=max(1, days) - 1)).replace(hour=0, minute=0, second=0, microsecond=0)

    messages: list[dict] = []
    page_token = ""
    for _ in range(20):
        data = _api_get(
            "/open-apis/im/v1/messages",
            {
                "container_id_type": "chat",
                "container_id": chat_id,
                "start_time": str(int(start.timestamp())),
                "end_time": str(int(end.timestamp())),
                # 按时间正序，方便在预览里顺着读；翻页多了也不会乱序
                "sort_type": "ByCreateTimeAsc",
                "page_size": 50,
                "with_sender_name": "true",
                "page_token": page_token,
            },
        )
        for item in data.get("items") or []:
            messages.append(_to_message(item))
        page_token = data.get("page_token") or ""
        if not data.get("has_more") or not page_token:
            break
    # 系统消息（置顶/撤回提示）转出来是空串，直接丢掉
    return [item for item in messages if item["text"].strip()]


def _sender_name(sender: dict | None) -> str:
    """取发送人显示名。

    接口在 with_sender_name=true 时返回 sender_name；没有就退到 sender_i18n_names。
    系统消息（置顶、撤回提示）的 sender 全是空串，这是正常的，不是出错。
    """
    if not sender:
        return ""
    name = sender.get("sender_name") or ""
    if name:
        return str(name)
    names = sender.get("sender_i18n_names")
    if isinstance(names, dict) and names:
        for locale in ("zh_cn", "en_us"):
            if names.get(locale):
                return str(names[locale])
        first = next(iter(names.values()), "")
        if first:
            return str(first)
    return str(sender.get("id") or "")


def _to_message(item: dict) -> dict:
    created = int(item.get("create_time") or 0) // 1000
    moment = datetime.fromtimestamp(created) if created else datetime.now()
    body = item.get("body") or {}
    msg_type = item.get("msg_type") or "text"
    return {
        "id": item.get("message_id") or "",
        "date": moment.date().isoformat(),
        "at": moment.strftime("%H:%M"),
        "sender": _sender_name(item.get("sender")) or "未署名",
        "msg_type": msg_type,
        "text": flatten_content(msg_type, body.get("content") or ""),
    }


def flatten_content(msg_type: str, content: str) -> str:
    """把各种消息类型压成一行可读文本，供通知解析器使用。"""
    try:
        payload = json.loads(content) if content else {}
    except ValueError:
        return content

    if msg_type == "text":
        return str(payload.get("text", ""))
    if msg_type == "post":
        return _flatten_post(payload)
    if msg_type == "image":
        return "[图片]"
    if msg_type == "file":
        return f"[文件] {payload.get('file_name', '')}".strip()
    if msg_type == "audio":
        return "[语音]"
    if msg_type == "media":
        return f"[视频] {payload.get('file_name', '')}".strip()
    if msg_type == "sticker":
        return "[表情]"
    if msg_type == "share_chat":
        return "[群名片]"
    if msg_type == "merge_forward":
        return "[合并转发的聊天记录]"
    if msg_type == "system":
        return ""
    if msg_type in ("interactive", "card"):
        title = payload.get("title") or ""
        elements = payload.get("elements") or []
        texts = [title] if title else []
        for element in elements if isinstance(elements, list) else []:
            for tag in (element.get("text") or {}).get("content", "").split("\n") if isinstance(element, dict) else []:
                if tag.strip():
                    texts.append(tag.strip())
        return " ".join(texts) or "[卡片消息]"
    return json.dumps(payload, ensure_ascii=False)[:500]


def _flatten_post(payload: dict) -> str:
    lines: list[str] = []
    for locale in ("zh_cn", "en_us", "ja_jp"):
        body = payload.get(locale)
        if not body:
            continue
        title = body.get("title") or ""
        if title:
            lines.append(title)
        for line in body.get("content") or []:
            parts = []
            for node in line:
                if not isinstance(node, dict):
                    continue
                tag = node.get("tag")
                if tag in ("text", "a", "md"):
                    parts.append(node.get("text", ""))
                elif tag == "at":
                    parts.append(f"@{node.get('user_name', '')}")
                elif tag in ("img", "media", "emotion"):
                    parts.append("[图片]")
            if parts:
                lines.append("".join(parts).strip())
        break
    return "\n".join(line for line in lines if line.strip())


# ------------------------------- 给 notice_bridge 用 -------------------------------


# 服务模式下点「扫码授权」的后台状态，前端轮询 status 就能看到进度。
LOGIN: dict = {"state": "idle", "url": "", "error": ""}


def login_async() -> dict:
    """在后台跑一次设备码授权，立刻返回；进度看 LOGIN。"""
    if LOGIN.get("state") == "pending":
        return dict(LOGIN)
    LOGIN.update(state="pending", url="", error="")

    def on_url(url: str, expire_in: int) -> None:
        LOGIN.update(url=url, expire_in=expire_in)

    def run() -> None:
        try:
            device_login(on_url=on_url)
            LOGIN.update(state="ok")
        except SystemExit as error:
            LOGIN.update(state="error", error=str(error))
        except Exception as error:  # noqa: BLE001
            LOGIN.update(state="error", error=f"{type(error).__name__}: {error}")

    threading.Thread(target=run, daemon=True, name="feishu-login").start()
    return dict(LOGIN)


def status() -> dict:
    auth = load_auth()
    now = int(time.time())
    return {
        "app_ready": bool(auth.get("client_id")),
        "client_id": auth.get("client_id", ""),
        "logged_in": bool(auth.get("access_token")),
        "expires_in": max(0, int(auth.get("expires_at", 0)) - now),
        "has_refresh": bool(auth.get("refresh_token")),
        "scope": auth.get("scope", ""),
        "login": dict(LOGIN),
    }


def sender_hit(sender: str, wanted: list[str]) -> bool:
    """发送人对不对得上；名单空就是全要。

    跟微信那路各有一份（两个模块不互相引用）。飞书里显示的是真实姓名，
    群里改过群昵称也不影响，按真名比就行。
    """
    if not wanted:
        return True
    name = (sender or "").strip()
    if not name:
        return False
    for item in wanted:
        if item in name or name in item:
            return True
    return False


def collect(
    chats: list[str],
    days: int = 1,
    senders: dict[str, list[str]] | None = None,
) -> tuple[list[dict], list[str]]:
    """按群名列表收集最近 days 天的消息，返回 (消息, 警告)。

    输出结构跟老的剪贴板路径完全一致，上层的通知解析器不用改：
    {source, sender, at, text, date}

    senders 是「群名 -> 只看这些人的消息」；没列的群整群都要。
    """
    warnings: list[str] = []
    if not load_auth().get("client_id"):
        return [], ["飞书还没配置：跑一次 python bridge/feishu_sdk.py register"]
    if not chats:
        return [], ["飞书群名单是空的，设置页里填上要读的群名"]

    try:
        visible = list_chats()
    except (NotLoggedIn, FeishuError) as error:
        return [], [str(error)]

    messages: list[dict] = []
    for name in chats:
        chat = resolve_chat(name, visible)
        if not chat:
            warnings.append(f"飞书群「{name}」没找到，检查名字或确认你在这个群里")
            continue
        try:
            raw = fetch_messages(chat["chat_id"], days)
        except (NotLoggedIn, FeishuError) as error:
            warnings.append(f"飞书群「{name}」读取失败：{error}")
            continue
        # 群里指定的人：先按群里显示的名字查，再按白名单里写的名字查（两者可能不完全一样）。
        wanted = (senders or {}).get(chat["name"]) or (senders or {}).get(name) or []
        for item in raw:
            if not sender_hit(item["sender"], wanted):
                continue
            messages.append(
                {
                    "source": chat["name"] or name,
                    "sender": item["sender"],
                    "at": item["at"],
                    "text": item["text"],
                    "date": item["date"],
                    "id": item["id"],
                }
            )
        if wanted:
            warnings.append(f"飞书群「{chat['name'] or name}」只看 {'、'.join(wanted)} 发的话")
    return messages, warnings


# ------------------------------- 命令行 -------------------------------


def main(argv: list[str]) -> int:
    action = argv[0] if argv else "status"

    if action == "register":
        result = register_app()
        print(f"client_id: {result['client_id']}")
        return 0

    if action == "login":
        device_login()
        return 0

    if action == "status":
        auth = load_auth()
        if not auth.get("client_id"):
            print("还没建应用：python feishu_auth.py register")
            return 1
        print(f"应用：{auth['client_id']}")
        left = int(auth.get("expires_at", 0)) - int(time.time())
        print(f"access_token：{'有效' if left > 0 else '已过期'}（剩 {max(left, 0) // 60} 分钟）")
        print(f"refresh_token：{'有' if auth.get('refresh_token') else '无'}")
        print(f"scope：{auth.get('scope') or '未知'}")
        try:
            token = ensure_token()
            print(f"取 token：正常（{token[:6]}…）")
        except RuntimeError as error:
            print(f"取 token：{error}")
            return 1
        return 0

    if action == "chats":
        chats = list_chats()
        print(f"共 {len(chats)} 个群：")
        for item in chats:
            print(f"  {item['name']}  ({item['chat_id']})")
        return 0

    if action == "test":
        chat_name = _arg(argv, "--chat")
        days = int(_arg(argv, "--days") or 1)
        if not chat_name:
            print("用法：python feishu_sdk.py test --chat 群名 [--days 3]")
            return 1
        chat = resolve_chat(chat_name)
        if not chat:
            print(f"没找到群「{chat_name}」，先跑 chats 看看有哪些")
            return 1
        messages = fetch_messages(chat["chat_id"], days)
        print(f"「{chat['name']}」最近 {days} 天共 {len(messages)} 条：")
        for item in messages:
            print(f"  {item['date']} {item['at']} {item['sender']}: {item['text'][:60]}")
        return 0

    print(__doc__)
    return 1


def _arg(argv: list[str], flag: str) -> str:
    if flag in argv:
        index = argv.index(flag)
        if index + 1 < len(argv):
            return argv[index + 1]
    return ""


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
