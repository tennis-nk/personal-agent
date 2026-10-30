"""本机通知助手。

给「一键安排」提供最近几天的通知（默认只看今天，最多往回一周）。
只监听 127.0.0.1，数据不出本机。

微信：wxauto4 直读白名单会话的消息，按日期分割条判断每条属于哪一天，
      只保留最近 N 天（N 由 config 的 wechat.days 或请求参数 ?days= 决定）。
      需要微信已登录并在前台可切换。
飞书：两种模式（config 里 feishu.mode 切换）。
      sdk      —— 走开放平台接口直读群消息，结构化、不用窗口在前台，要先扫码授权一次
                  （见 feishu_sdk.py，凭据存在 bridge/feishu_auth.json）。
      clipboard —— 老办法。飞书界面是 Chromium 自绘的，UIA 里读不到聊天文本
                  （实测只有一个水印节点），所以把窗口弹到前台，你复制，脚本读剪贴板。

用法：
    python notice_bridge.py            # 常驻服务
    python notice_bridge.py --once     # 抓一次当天消息打印出来，用于排查
    python notice_bridge.py --config   # 打印配置文件路径
"""

from __future__ import annotations

import json
import queue
import re
import sys
import threading
import time
import traceback
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent

# 飞书 SDK 是可选依赖：没装 SDK 或没配置授权时自动退回剪贴板模式，不该让整个服务起不来。
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
try:
    import feishu_sdk  # noqa: E402
except Exception:  # noqa: BLE001
    feishu_sdk = None
CONFIG_PATH = HERE / "config.json"
LOG_PATH = HERE / "bridge.log"

DEFAULT_CONFIG = {
    "port": 8787,
    "wechat": {
        "enabled": True,
        # 只这几个会话会被读取，避免把私人聊天也扫进来。留空则完全不读微信。
        "sessions": [],
        "max_messages": 60,
        # 往回取几天：1 = 只看今天，最多 7。前端可以按请求临时覆盖。
        "days": 1,
        # 读完把微信收回任务栏。想让它读完就停在屏幕上，改成 false。
        "auto_hide": True,
    },
    "feishu": {
        "enabled": True,
        # sdk：走开放平台接口直读群消息（要一次性扫码授权）；
        # clipboard：老办法，把飞书弹到前台，你复制、脚本读剪贴板。
        "mode": "clipboard",
        # sdk 模式要读的群名，留空则什么都不读。
        "chats": [],
        # 往回取几天：1 = 只看今天，最多 7。
        "days": 1,
        # 窗口标题关键词，用于把飞书弹到前台（clipboard 模式用）。
        "window": "飞书",
        # 飞书读不到窗口文本，clipboard 模式改读剪贴板。
        "use_clipboard": True,
    },
}

DATE_PATTERNS = [
    re.compile(r"(\d{4})年(\d{1,2})月(\d{1,2})日"),
    re.compile(r"(\d{1,2})月(\d{1,2})日"),
]
TIME_PATTERN = re.compile(r"(\d{1,2}):(\d{2})")
WEEKDAY_NAMES = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]


# 终端输出可能是个已经断掉的管道（被人用 `| head` 截过、或控制台窗口已关）。
# 写不出去是小事，绝不能因为它把请求处理线程炸掉——一旦炸掉，每个请求都在
# 返回响应前断开，整个助手看着就像「所有功能都失效」。断过一次就不再往终端写。
_stdout_broken = False


def log(message: str) -> None:
    global _stdout_broken
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {message}"
    if not _stdout_broken:
        try:
            print(line, flush=True)
        except (OSError, ValueError):
            _stdout_broken = True
    try:
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"已生成配置文件：{CONFIG_PATH}，把你要读的群名填进去")
        return json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        log(f"配置读不出来（{error}），先用默认配置")
        return json.loads(json.dumps(DEFAULT_CONFIG))
    merged = json.loads(json.dumps(DEFAULT_CONFIG))
    for key, value in data.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key].update(value)
        else:
            merged[key] = value
    return merged


# --------------------------------------------------------------------------- #
# 微信
# --------------------------------------------------------------------------- #

_wx_lock = threading.Lock()
_wx = None

# wxauto4 走 COM，而 COM 是单线程的：在哪个线程初始化，就只能在那个线程用。
# HTTP 请求是 ThreadingHTTPServer 的子线程，直接调会报「尚未调用 CoInitialize」，
# 就算初始化了，换一个线程用同一个实例也会出错。所以微信相关的活全部丢给这一个线程干。
_wx_jobs: "queue.Queue" = None  # type: ignore[assignment]  # 在 _wx_start 里建
_wx_started = False


def _wx_worker() -> None:
    try:
        import pythoncom  # type: ignore

        pythoncom.CoInitialize()
    except Exception as error:  # noqa: BLE001
        log(f"COM 初始化失败：{error}")

    while True:
        job, box = _wx_jobs.get()
        try:
            box.put((True, job()))
        except Exception as error:  # noqa: BLE001
            box.put((False, error))


def _wx_start() -> None:
    global _wx_jobs, _wx_started
    with _wx_lock:
        if _wx_started:
            return
        _wx_jobs = queue.Queue()
        threading.Thread(target=_wx_worker, daemon=True, name="wx-worker").start()
        _wx_started = True


def wx_call(job, timeout: float = 30.0):
    """把一次微信操作交给工作线程，等结果。超时就抛，别把 HTTP 请求挂死。"""
    _wx_start()
    box: "queue.Queue" = queue.Queue()
    _wx_jobs.put((job, box))
    try:
        ok, value = box.get(timeout=timeout)
    except queue.Empty:
        raise TimeoutError(f"微信操作超过 {timeout:.0f} 秒没返回") from None
    if ok:
        return value
    raise value


class WxMissing(RuntimeError):
    """当前解释器没装 wxauto4。单独一个异常类型，好在界面上给准确的出路。"""


def wx_ready() -> tuple[bool, str]:
    """探一下微信这条路能不能走：装没装 wxauto4、依赖齐不齐。

    /health 和设置页都用它，免得用户对着「没连上」猜半天。
    """
    try:
        import wxauto4  # type: ignore  # noqa: F401
        return True, ""
    except Exception as error:  # noqa: BLE001
        return False, f"{type(error).__name__}: {error}"


def wx_instance():
    """懒加载微信实例，失败就抛，由调用方转成提示。"""
    global _wx
    if _wx is not None:
        return _wx
    try:
        from wxauto4 import WeChat  # type: ignore
    except Exception as error:  # noqa: BLE001
        # 这个解释器里没有 wxauto4（或者缺它的依赖，比如 tkinter）。
        # 直接把当前解释器路径和正确启动方式说出来，比「No module named」有用得多。
        raise WxMissing(
            f"当前解释器没有可用的 wxauto4（{error}）。"
            f"它跑在 {sys.executable}。"
            "换装了 wxauto4 的那个解释器启动：py -3.13 bridge/notice_bridge.py"
        ) from error

    _wx = WeChat()
    log("微信已连接")
    return _wx


def message_fields(message) -> tuple[str, str]:
    """从 wxauto4 的消息对象里掏出发送人和正文。

    不同版本字段名不一样，这里按可能性依次试，拿不到就退成空串。
    """
    sender = ""
    for attr in ("sender", "sender_remark", "nickname", "from"):
        value = getattr(message, attr, None)
        if isinstance(value, str) and value.strip():
            sender = value.strip()
            break

    text = ""
    for attr in ("content", "text", "msg", "message"):
        value = getattr(message, attr, None)
        if isinstance(value, str) and value.strip():
            text = value.strip()
            break
    if not text:
        control = getattr(message, "control", None)
        value = getattr(control, "Name", None) if control is not None else None
        if isinstance(value, str):
            text = value.strip()
    return sender, text


_CLOCK_TAIL = re.compile(r"(?:\s*[上下晚早凌]午?)?\s*\d{1,2}[:：]\d{2}\s*$")
# 分割条必须是「整条就是一个日期」，不能用 search 去正文里捞：
# 否则「10月28日晚上七点开会」会被当成分割条整条丢掉。
_DIVIDER_PATTERNS = [
    re.compile(r"^(\d{4})年(\d{1,2})月(\d{1,2})日$"),
    re.compile(r"^(\d{1,2})月(\d{1,2})日$"),
    re.compile(r"^(?:星期|周)([一二三四五六日天])$"),
]
_WEEKDAY_INDEX = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}
# 只写时间的分割条（今天的消息默认只显示 HH:MM，不写「今天」）。
_CLOCK_ONLY = re.compile(r"^(?:[上下晚早凌]午?)?\s*\d{1,2}[:：]\d{2}$")
_SYSTEM_SENDERS = ("system", "系统", "系统消息")


def _is_system(sender: str) -> bool:
    return sender.strip().lower() in _SYSTEM_SENDERS


def parse_date_context(text: str, today: date) -> date | None:
    """消息流里的日期分割条，用来判断后面的消息属于哪一天。

    微信 4.x 的分割条长这样：「星期三 17:22」「昨天 12:15」「10月28日 09:31」，
    尾巴上挂着时间，所以先把时间削掉再比对。这类条子挂在 sender=system 名下，
    但 system 名下还有「XX 加入了群聊」这种正经通知，因此判断只看文本形状。
    """
    value = _CLOCK_TAIL.sub("", text.strip()).strip()
    if not value or len(value) > 24:
        return None

    if value == "今天":
        return today
    if value == "昨天":
        return today - timedelta(days=1)
    if value == "前天":
        return today - timedelta(days=2)

    for pattern in _DIVIDER_PATTERNS:
        match = pattern.fullmatch(value)
        if not match:
            continue
        groups = match.groups()

        if len(groups) == 3:
            try:
                return date(int(groups[0]), int(groups[1]), int(groups[2]))
            except ValueError:
                return None

        if len(groups) == 1 and groups[0] in _WEEKDAY_INDEX:
            monday = today - timedelta(days=today.weekday())
            candidate = monday + timedelta(days=_WEEKDAY_INDEX[groups[0]])
            # 往前翻聊天记录时「星期六」只能指上周六；算到未来就说明是上一轮。
            if candidate > today:
                candidate -= timedelta(days=7)
            return candidate

        # 只有月日：先按今年算，跨年时（1 月看到 12 月 31 日）退回上一年。
        try:
            candidate = date(today.year, int(groups[0]), int(groups[1]))
        except ValueError:
            return None
        if candidate > today:
            try:
                candidate = candidate.replace(year=today.year - 1)
            except ValueError:
                return None
        return candidate
    return None


# 群里的系统通告：进群退群、撤回、拍一拍、改群名。排日程时全是噪音，
# 留在消息流里只会让「一键安排」把它们送进模型。
_NOISE_RULES = (
    "加入了群聊",
    "退出了群聊",
    "撤回了一条消息",
    "拍了拍",
    "修改群名为",
    "移出了群聊",
    "开启了群聊邀请确认",
    "关闭了群聊邀请确认",
)


def is_system_noise(sender: str, text: str) -> bool:
    """sender 是 system 且正文是通告模板，就丢掉。"""
    if not _is_system(sender):
        return False
    body = text.strip()
    return any(rule in body for rule in _NOISE_RULES)


def parse_group_entry(entry: str) -> tuple[str, list[str]]:
    """白名单里的一行：「群名」或「群名|张三,李四」。

    竖线后面是「只看这些人的消息」。微信和飞书各填各的，同一个人在两个应用里
    显示名不一样也不会串——微信里是群昵称，飞书里是真名。
    """
    if not isinstance(entry, str):
        return "", []
    name, _, tail = entry.partition("|")
    senders = [item.strip() for item in re.split(r"[,，、;；]", tail) if item.strip()]
    return name.strip(), senders


def sender_hit(sender: str, wanted: list[str]) -> bool:
    """发送人对不对得上。名单是空的就是都要。

    用包含判断而不是全等：群里显示名常带后缀（「王超老师」「王超-辅导员」），
    写「王超」应该能命中。
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


SESSION_NOISE = {"折叠的聊天", "服务号", "订阅号", "微信团队", "文件传输助手", "微信支付", "微信游戏"}
# 会话列表一次取一屏，往下滚到底最多也用不了太多屏；留个上限防止滚动异常情况卡很久。
SESSION_SCROLL_LIMIT = 60


def _session_names(wx) -> list[str]:
    """从当前这一屏会话里取名字。"""
    names: list[str] = []
    for item in wx.GetSession() or []:
        value = None
        for attr in ("name", "Name", "nickname", "remark"):
            candidate = getattr(item, attr, None)
            if isinstance(candidate, str) and candidate.strip():
                value = candidate.strip()
                break
        if value is None:
            info = getattr(item, "info", None)
            if isinstance(info, dict):
                candidate = info.get("name") or info.get("nickname")
                if isinstance(candidate, str) and candidate.strip():
                    value = candidate.strip()
        if value:
            names.append(value)
    return names


def list_wechat_sessions() -> tuple[list[str], str]:
    """列出微信会话名，省得用户手打群名。微信没开就返回空。

    微信的会话列表是一次只渲染一屏的虚拟列表，直接 GetSession() 只能拿到屏幕上那十来条，
    要填白名单的群多半在下面根本找不到。所以这里边往下滚边收，滚到底为止。
    """

    def job() -> list[str]:
        import time

        wx = wx_instance()
        wx.SwitchToChat()
        box = getattr(wx, "SessionBox", None)
        if box is not None:
            try:
                box.go_top()
                time.sleep(0.3)
            except Exception as error:  # noqa: BLE001
                log(f"会话列表回到顶部失败：{error}")

        names: list[str] = []
        seen: set[str] = set()

        def collect() -> int:
            added = 0
            for name in _session_names(wx):
                if name in seen:
                    continue
                seen.add(name)
                names.append(name)
                added += 1
            return added

        collect()
        stale = 0
        if box is not None:
            for _ in range(SESSION_SCROLL_LIMIT):
                try:
                    box.roll_down()
                except Exception as error:  # noqa: BLE001
                    log(f"会话列表滚动失败：{error}")
                    break
                time.sleep(0.25)
                if collect() == 0:
                    stale += 1
                    # 连着两屏都没新名字，基本到底了；连续失败也别空耗。
                    if stale >= 2:
                        break
                else:
                    stale = 0
            # 滚完回到顶部，别把用户的会话列表留在半中间。
            try:
                box.go_top()
            except Exception:  # noqa: BLE001
                pass
        return names

    shown, why = show_wechat()
    if not shown:
        return [], f"读不了会话名：{why}"
    try:
        raw = wx_call(job, timeout=180)
    except WxMissing as error:
        return [], str(error)
    except Exception as error:  # noqa: BLE001
        return [], f"读会话列表失败：{error}"
    finally:
        # 读完收回去，别让微信一直占着屏幕（config 里 wechat.auto_hide 设 false 可以留着不收）。
        if load_config().get("wechat", {}).get("auto_hide", True):
            hide_wechat()

    if not raw:
        return [], "会话列表是空的：确认微信已经登录并停在聊天页"
    # 去重、保序，顺手滤掉界面上的固定条目（不是会话）
    unique = [name for name in raw if name not in SESSION_NOISE]
    return unique, ""


def _fold(text: str) -> str:
    """把文本压成比对用的 key：换行和连续空格在控件名与时分 {消息对象} 里不一致。"""
    return re.sub(r"\s+", "", text or "")


# 纯文本气泡。图片/文件/动画表情是另一批类名，长通知只会出现在这种身上。
_TEXT_ITEM_CLASSES = ("ChatTextItemView",)


def _chat_board(wx):
    """当前聊天对象的消息面板控件。"""
    box = getattr(wx, "ChatBox", None)
    return getattr(box, "msgbox", None) if box is not None else None


def _board_snapshot(board, wx) -> tuple[list[tuple[str, str]], dict[str, str]]:
    """读一屏消息：[(类名, 正文) 按界面顺序]，外加 {正文 key -> 发言人}。

    正文直接从控件的显示文本上取——超长通知整屏只渲染它一个的时候，
    控件上仍然带着全文，能拿到。

    发言人只能回头找 wxauto4 要：昵称藏在气泡的子控件里，列表一虚拟化就回收了，
    控件上一问三不知。所以这里是「两路结果按正文对表」，对不上的留空，
    由 _pick_entries 决定要不要。
    """
    try:
        stream = [((item.Name or "").strip(), _class_of(item)) for item in board.GetChildren()]
    except Exception as error:  # noqa: BLE001
        log(f"读消息面板失败：{error}")
        return [], {}

    senders: dict[str, str] = {}
    for message in wx.GetAllMessage() or []:
        sender, text = message_fields(message)
        sender = (sender or "").strip()
        text = (text or "").strip()
        if not sender or not text:
            continue
        senders.setdefault(_fold(text), sender)
    return [pair for pair in stream if pair[0]], senders


def _class_of(item) -> str:
    try:
        return str(getattr(item, "ClassName", "") or "")
    except Exception:  # noqa: BLE001
        return ""


def _read_chat_stream(wx, rounds: int, pause: float) -> list[tuple[str, str]]:
    """把一个聊天窗口的消息从头到尾捋一遍，给回 [(发言人, 正文)]。

    微信 4.x 的聊天区是虚拟列表：只有屏幕里那几条真的存在。光靠 wxauto4 一次读取，
    拿到的就是当前这一屏；作业通知那种一屏放不下的长消息更麻烦——它整屏只渲染一个，
    而 wxauto4 不认这种形态，会连着整屏一起返回 0 条。

    所以这里自己贴着列表慢慢往上滚，一屏一屏存下来再按位置拼成完整消息流，
    缺失的发言人另找 wxauto4 对表补上。
    """
    board = _chat_board(wx)
    if board is None:
        return [message_fields(message) for message in wx.GetAllMessage() or []]

    # 先贴到底，保证第一屏就是最新的消息。
    for _ in range(3):
        try:
            board.WheelDown(wheelTimes=3, waitTime=0.03)
        except Exception:  # noqa: BLE001
            break
    time.sleep(pause)

    frames: list[list[tuple[str, str]]] = []
    senders: dict[str, str] = {}
    for _ in range(max(1, rounds)):
        stream, mapping = _board_snapshot(board, wx)
        senders.update(mapping)
        if stream and (not frames or frames[-1] != stream):
            frames.append(stream)
        try:
            board.WheelUp(wheelTimes=2, waitTime=0.03)
        except Exception:  # noqa: BLE001
            break
        time.sleep(pause)

    if not frames:
        return [message_fields(message) for message in wx.GetAllMessage() or []]

    # frames[0] 最靠下（最新），最后一屏最旧；倒着拼回来就是完整的消息顺序。
    ordered: list[tuple[str, str]] = []
    seen: set[str] = set()
    for frame in reversed(frames):
        for text, kind in frame:
            key = _fold(text)
            if key in seen:
                continue
            seen.add(key)
            ordered.append((text, kind))

    entries: list[tuple[str, str]] = []
    for text, kind in ordered:
        sender = senders.get(_fold(text), "")
        if not sender and not any(name in kind for name in _TEXT_ITEM_CLASSES):
            # 读不出发言人的图片、文件、表情，多半是群里的闲聊，丢掉不心疼；
            # 纯文本的通知（作业、截止日期）才值得冒这个险。
            continue
        entries.append((sender, text))
    return entries


def read_wechat(config: dict, today: date, days: int = 1) -> tuple[list[dict], list[str]]:
    section = config.get("wechat", {})
    warnings: list[str] = []
    if not section.get("enabled"):
        return [], warnings

    entries = [
        parsed
        for parsed in (parse_group_entry(item) for item in section.get("sessions", []))
        if parsed[0]
    ]
    if not entries:
        warnings.append("微信白名单是空的，在 config.json 的 wechat.sessions 里填上群名")
        return [], warnings
    sessions = [name for name, _ in entries]
    # 群里指定的人：留空就是整个群都要。
    wanted_map = {name: senders for name, senders in entries}

    days = max(1, min(7, int(days or 1)))
    # 聊天区是虚拟列表，一屏只有几条；往上多滚几屏才看得到更早的通知。
    rounds = max(1, min(8, int(section.get("scroll_rounds", 5) or 5)))
    pause = 0.5

    def job() -> tuple[list[dict], list[str]]:
        wx = wx_instance()
        found: list[dict] = []
        notes: list[str] = []
        unnamed = 0
        for name in sessions:
            try:
                wx.ChatWith(name, exact=False)
            except Exception as error:  # noqa: BLE001
                notes.append(f"打开会话「{name}」失败：{error}")
                continue
            time.sleep(0.6)
            wanted = wanted_map.get(name) or []
            try:
                messages, missed = _pick_entries(
                    name,
                    _read_chat_stream(wx, rounds, pause),
                    today,
                    days,
                    wanted,
                )
            except Exception as error:  # noqa: BLE001
                notes.append(f"读取「{name}」失败：{error}")
                continue
            unnamed += missed
            found.extend(messages)
            if wanted:
                notes.append(f"「{name}」只看 {'、'.join(wanted)} 发的话")
        if unnamed:
            notes.append(
                f"有 {unnamed} 条消息认不出发言人（列表虚拟化把昵称回收了），"
                "已按群里成员不明放行，请自己在预览里挑一下"
            )
        return found, notes

    # wxauto4 抓的是界面控件：窗口缩在任务栏时它一直空等到超时，
    # 报出来的错像「没登录」，其实是没展开。读之前先放出来。
    shown, why = show_wechat()
    if not shown:
        warnings.append(f"微信没读成：{why}")
        return [], warnings

    try:
        found, notes = wx_call(job, timeout=_wx_timeout(len(sessions), rounds))
        warnings.extend(notes)
        return found, warnings
    except WxMissing as error:
        warnings.append(f"微信没读成：{error}")
        return [], warnings
    except Exception as error:  # noqa: BLE001
        warnings.append(f"微信没读成：{error}。确认微信已登录并停在聊天页")
        return [], warnings
    finally:
        # 读完就收回去，别让微信一直占着屏幕。config 里 wechat.auto_hide 设 false 可以留着不收。
        if section.get("auto_hide", True):
            hide_wechat()


def _wx_timeout(sessions: int, rounds: int = 5) -> float:
    """读一批会话给多久。

    一个会话连切换带滚几屏大约十几秒；固定 40 秒在读一周 × 十个群时必然超时，
    看着像微信坏了。按会话数和滚动轮数放宽，上限兜住别把 HTTP 请求挂太久。
    """
    per_chat = 6.0 + 1.2 * max(1, rounds)
    return float(min(max(60, per_chat * max(1, sessions)), 300))


def _pick_window(
    source: str,
    raw: list,
    today: date,
    days: int = 1,
    wanted: list[str] | None = None,
) -> list[dict]:
    """wxauto4 消息对象列表版，见 _pick_entries。"""
    messages, _ = _pick_entries(
        source, [message_fields(message) for message in raw], today, days, wanted
    )
    return messages


def _pick_entries(
    source: str,
    entries: list[tuple[str, str]],
    today: date,
    days: int = 1,
    wanted: list[str] | None = None,
) -> tuple[list[dict], int]:
    """从一个会话的消息流里挑出最近 days 天的。

    消息流里没有绝对日期，靠日期分割条（今天 / 昨天 / 10月29日）判断归属：
    遇到分割条就换上下文，之后的消息都归到这一天。

    每条消息都带上它所属的日期（date），前端算「明天下午两点」时要用这一天做基准，
    否则往回取三天时，前天说的「明天」会被算成今天往后一天。

    wanted 是这个群里指定要看的人；空就是全要。
    """
    days = max(1, min(7, int(days or 1)))
    cutoff = today - timedelta(days=days - 1)
    messages: list[dict] = []
    # leading 记录「还没见到任何分割条就先记下来的那几条」，末尾跟着第一条分割条改日期。
    leading: list[dict] = []
    first_divider: date | None = None
    context: date | None = None

    for sender, text in entries:
        sender = (sender or "").strip()
        text = (text or "").strip()
        if not text:
            continue
        # 分割条先认，不管 sender 是什么：4.x 把它挂在 system 名下，
        # 按「sender 为空才是分割条」判断会全部漏掉，整段对话都被算成今天，
        # 于是「明天下午两点」整体错位一天、已经结束的活动又被排进日程。
        guessed = parse_date_context(text, today)
        if guessed is None and _CLOCK_ONLY.fullmatch(text.strip()) and _is_system(sender):
            # 「今天」的分割条只写时间（08:55），没有「今天」两个字，得单独认。
            guessed = today
        if guessed is not None:
            context = guessed
            if first_divider is None and guessed < today:
                # 头几条消息之前没有分割条，先按今天记了；这里看到第一条是更早的一天，
                # 那就跟着它改回去，别把旧通知顶到今天。
                first_divider = guessed
                for message in leading:
                    message["date"] = guessed.isoformat()
                leading = []
            continue
        if is_system_noise(sender, text):
            continue
        # 指定了人，就只留这个人发的。没指定（wanted 为空）就整群都要。
        # 发言人缺失时放行：那是列表虚拟化把昵称回收了，读不出人名但内容多半是正经通知，
        # 宁可让用户自己在预览里删，也别把作业截止日整条丢了。
        if wanted and sender and not sender_hit(sender, wanted):
            continue
        # dates 超出窗口的先留着，末尾统一筛——前面还可能被第一条分割条改到窗口里来。
        # 长通知里数字到处都是（几十道题号、几个截止时间），从中随手抓一个当时间
        # 比不标时间更害人——宁可空着，让模型自己去看全文。
        match = TIME_PATTERN.search(text) if len(text) <= 120 else None
        messages.append(
            {
                "source": source,
                "sender": sender or "发言人未知",
                "at": match.group(0) if match else "",
                "date": context.isoformat() if context else today.isoformat(),
                "text": text,
            }
        )
        if context is None:
            leading.append(messages[-1])

    floor = cutoff.isoformat()
    ceiling = today.isoformat()
    kept = [message for message in messages if floor <= message["date"] <= ceiling]
    # 认不出发言人的条数：列表虚拟化把昵称回收了，只在末尾统计一下告诉用户。
    unnamed = sum(1 for message in kept if message["sender"] == "发言人未知")
    return kept, unnamed


# --------------------------------------------------------------------------- #
# 飞书
# --------------------------------------------------------------------------- #

def force_foreground(hwnd: int) -> bool:
    """把一个窗口真正切到前台。

    最小化的先还原、藏起来的先显示，再挂一下输入线程才能抢到前台——
    不挂的话 Windows 常常直接拒绝，看起来像「唤不起」。
    """
    try:
        import win32con  # type: ignore
        import win32gui  # type: ignore
        import win32process  # type: ignore
    except Exception as error:  # noqa: BLE001
        log(f"缺少 pywin32，切不了前台：{error}")
        return False

    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        elif not win32gui.IsWindowVisible(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
        current = win32gui.GetForegroundWindow()
        if current == hwnd:
            return True
        # 不挂一下输入线程，Windows 常常拒绝切换前台窗口。
        threads = (
            win32process.GetWindowThreadProcessId(current)[0],
            win32process.GetWindowThreadProcessId(hwnd)[0],
        )
        win32process.AttachThreadInput(*threads, True)
        win32gui.SetForegroundWindow(hwnd)
        win32process.AttachThreadInput(*threads, False)
        return True
    except Exception as error:  # noqa: BLE001
        log(f"切换前台失败：{error}")
        return False


def wechat_hwnd() -> int:
    """找微信主窗口。

    优先按类名（WeChatMainWndForPC）找，比标题稳：缩在任务栏、标题被改成
    「微信 (2)」、甚至收进托盘（窗口整个隐藏）都还能找到。
    """
    try:
        import win32gui  # type: ignore
    except Exception:  # noqa: BLE001
        return 0

    hwnd = win32gui.FindWindow("WeChatMainWndForPC", None)
    if hwnd:
        return hwnd

    found: list[int] = []

    def _enum(handle: int, _: object) -> None:
        title = win32gui.GetWindowText(handle) or ""
        if "微信" in title:
            found.append(handle)

    win32gui.EnumWindows(_enum, None)
    return found[0] if found else 0


def open_in_browser(url: str) -> bool:
    """用系统默认浏览器打开一个链接。

    只放 accounts.feishu.cn 这一处：本地服务虽然只监听 127.0.0.1，
    但开放「任意 URL」给浏览器打开，等于给本机留一条任意跳转的口子，
    没必要。校验不过就返回失败，前端照旧把链接显示出来让用户自己点。
    """
    if not url:
        return False
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "accounts.feishu.cn":
        log(f"拒绝打开非飞书授权链接：{parsed.scheme}://{parsed.hostname}")
        return False
    try:
        import webbrowser

        return bool(webbrowser.open(url))
    except Exception as error:  # noqa: BLE001
        log(f"打开浏览器失败：{error}")
        return False


def show_wechat() -> tuple[bool, str]:
    """读之前把微信从任务栏（或托盘）里放出来。

    wxauto4 抓的是界面控件，窗口缩起来时它只会一直等，最后报一句
    「超过 40 秒没返回」——看着像没登录，其实只是窗口没展开。
    """
    hwnd = wechat_hwnd()
    if not hwnd:
        return False, "没找到微信窗口，确认微信是登录着的"
    if not force_foreground(hwnd):
        return False, "微信窗口切不到前台，手动点一下再试"
    # 还原之后要等界面画出来，控件树才完整，太快抓会抓到空列表。
    time.sleep(0.8)
    return True, ""


def hide_wechat() -> bool:
    """读完之后把微信收回任务栏，别一直占着屏幕。"""
    hwnd = wechat_hwnd()
    if not hwnd:
        return False
    try:
        import win32con  # type: ignore
        import win32gui  # type: ignore

        win32gui.ShowWindow(hwnd, win32con.SW_MINIMIZE)
        return True
    except Exception as error:  # noqa: BLE001
        log(f"收起微信窗口失败：{error}")
        return False


def activate_window(keyword: str) -> bool:
    """把窗口弹到前台。

    飞书要用它唤起：你在里面复制完总结，脚本再读剪贴板。
    用 win32 枚举窗口，比 UIA 稳——飞书的 UIA 树里基本没有可用节点。
    """
    try:
        import win32gui  # type: ignore
    except Exception as error:  # noqa: BLE001
        log(f"缺少 pywin32，唤不起窗口：{error}")
        return False

    found: list[int] = []

    def _enum(hwnd: int, _: object) -> None:
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd) or ""
        if keyword.lower() in title.lower():
            found.append(hwnd)

    win32gui.EnumWindows(_enum, None)
    if not found:
        return False

    return force_foreground(found[0])


def read_clipboard() -> str:
    try:
        import win32clipboard as clipboard  # type: ignore
    except Exception:  # noqa: BLE001
        try:
            import subprocess

            result = subprocess.run(["powershell", "-NoProfile", "-Command", "Get-Clipboard"], capture_output=True, text=True)
            return result.stdout.strip()
        except Exception:  # noqa: BLE001
            return ""

    try:
        clipboard.OpenClipboard()
        try:
            data = clipboard.GetClipboardData(clipboard.CF_UNICODETEXT)
        finally:
            clipboard.CloseClipboard()
    except Exception as error:  # noqa: BLE001
        log(f"读剪贴板失败：{error}")
        return ""
    return data.strip() if isinstance(data, str) else ""


def read_feishu(config: dict, days: int = 1) -> tuple[list[dict], list[str]]:
    section = config.get("feishu", {})
    warnings: list[str] = []
    if not section.get("enabled"):
        return [], warnings

    if section.get("mode") == "sdk":
        # 走开放平台接口：结构化、不用窗口在前台，支持按群和时间范围批量拉。
        # 天数跟请求走（?days=），和微信那一路保持一致，弹窗里改范围立刻生效。
        if feishu_sdk is None:
            return [], ["飞书 SDK 不可用：在本机跑一次 pip install lark-oapi"]
        entries = [
            parsed
            for parsed in (parse_group_entry(item) for item in section.get("chats", []))
            if parsed[0]
        ]
        if not entries:
            return [], ["飞书群名单是空的，设置页里填上要读的群名"]
        # 飞书里是真实姓名，和微信的群昵称不是一套，各填各的。
        return feishu_sdk.collect(
            [name for name, _ in entries],
            days,
            {name: senders for name, senders in entries if senders},
        )

    if not section.get("use_clipboard", True):
        return [], warnings

    text = read_clipboard()
    if not text:
        warnings.append("剪贴板是空的：在飞书里复制智能体的总结（Ctrl+A / Ctrl+C），再点一次读取")
        return [], warnings
    return [
        {
            "source": "飞书剪贴板",
            "sender": "",
            "at": datetime.now().strftime("%H:%M"),
            "text": text,
        }
    ], warnings


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

def collect(config: dict, days: int | None = None) -> dict:
    today = datetime.now().date()
    if days is None:
        days = int(config.get("wechat", {}).get("days", 1) or 1)
    days = max(1, min(7, days))
    messages: list[dict] = []
    warnings: list[str] = []

    try:
        wechat, wx_warnings = read_wechat(config, today, days)
        # 打渠道标记：前端要按「微信 / 飞书」分开显示，群名本身看不出来自哪个软件。
        for message in wechat:
            message["channel"] = "微信"
        messages.extend(wechat)
        warnings.extend(wx_warnings)
    except Exception:  # noqa: BLE001
        log("微信读取异常：\n" + traceback.format_exc())
        warnings.append("微信读取异常，详见 bridge.log")

    try:
        feishu, fs_warnings = read_feishu(config, days)
        for message in feishu:
            message["channel"] = "飞书"
        messages.extend(feishu)
        warnings.extend(fs_warnings)
    except Exception:  # noqa: BLE001
        log("飞书读取异常：\n" + traceback.format_exc())
        warnings.append("飞书读取异常，详见 bridge.log")

    seen: set[tuple[str, str]] = set()
    unique: list[dict] = []
    for message in messages:
        # SDK 路径有稳定的消息 ID，优先用它去重；剪贴板路径只能按来源+文本比。
        key = (message["source"], message.get("id") or message["text"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(message)

    return {"date": today.isoformat(), "days": days, "messages": unique, "warnings": warnings}


class Handler(BaseHTTPRequestHandler):
    config: dict = DEFAULT_CONFIG

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, message: str) -> None:
        """路由里出岔子时的兜底：宁可回一个看不懂的 JSON，也别把连接掐断。

        掐断连接的后果很重——前端收不到任何响应，界面上表现为「功能失效」，
        而日志里可能只有一句没人看的 traceback。这里统一记下来并回 500。
        """
        try:
            self._send(500, {"ok": False, "error": message})
        except Exception:  # noqa: BLE001
            pass

    def do_GET(self) -> None:  # noqa: N802
        try:
            self.route_get()
        except Exception:  # noqa: BLE001
            log("GET 处理出错：\n" + traceback.format_exc())
            self._fail("服务端处理出错，详见 bridge.log")

    def do_POST(self) -> None:  # noqa: N802
        try:
            self.route_post()
        except Exception:  # noqa: BLE001
            log("POST 处理出错：\n" + traceback.format_exc())
            self._fail("服务端处理出错，详见 bridge.log")

    def route_get(self) -> None:
        route = urlparse(self.path)
        query = parse_qs(route.query)

        if route.path == "/health":
            self._send(
                200,
                {
                    "ok": True,
                    "port": self.config.get("port", 8787),
                    "wechat_enabled": bool(self.config.get("wechat", {}).get("enabled")),
                    "wechat_days": int(self.config.get("wechat", {}).get("days", 1) or 1),
                    "feishu_enabled": bool(self.config.get("feishu", {}).get("enabled")),
                    "feishu_mode": self.config.get("feishu", {}).get("mode", "clipboard"),
                    "feishu_sdk": feishu_sdk is not None,
                    "python": sys.executable,
                    "wechat_ready": wx_ready()[0],
                    "wechat_error": wx_ready()[1],
                },
            )
            return

        if route.path == "/feishu/status":
            if feishu_sdk is None:
                self._send(200, {"ok": False, "error": "没装 lark-oapi，先 pip install lark-oapi"})
                return
            payload = {"ok": True, **feishu_sdk.status()}
            self._send(200, payload)
            return

        if route.path == "/feishu/chats":
            if feishu_sdk is None:
                self._send(200, {"chats": [], "error": "没装 lark-oapi"})
                return
            try:
                chats = feishu_sdk.list_chats()
                self._send(200, {"chats": [item["name"] for item in chats if item["name"]], "error": ""})
            except Exception as error:  # noqa: BLE001
                log("读飞书群列表异常：" + traceback.format_exc())
                self._send(200, {"chats": [], "error": str(error) or "读取失败"})
            return

        if route.path == "/feishu/open":
            # 网页里 window.open 在 file:// 下常被拦；交给本机脚本开默认浏览器更稳。
            target = (query.get("url") or [""])[0].strip()
            opened = open_in_browser(target)
            self._send(200, {"ok": opened, "url": target})
            return

        if route.path == "/activate":
            app = (query.get("app") or ["feishu"])[0]
            keyword = "微信" if app == "wechat" else self.config.get("feishu", {}).get("window", "飞书")
            ok = activate_window(keyword)
            self._send(200, {"ok": ok, "app": app})
            return

        if route.path == "/sessions":
            names, error = list_wechat_sessions()
            self._send(200, {"sessions": names, "error": error})
            return

        if route.path == "/config":
            self._send(200, {"config": self.config})
            return

        if route.path == "/today":
            # ?days=N 让前端临时改收集范围，不改 config 也能取最近一周。
            raw_days = (query.get("days") or [""])[0].strip()
            try:
                days = int(raw_days) if raw_days else None
            except ValueError:
                days = None
            self._send(200, collect(self.config, days))
            return

        self._send(404, {"error": "not found"})

    def route_post(self) -> None:
        """只开放几个安全字段，端口改动也要落盘，避免下次启动又变回去。"""
        route = urlparse(self.path)

        if route.path == "/feishu/login":
            if feishu_sdk is None:
                self._send(200, {"ok": False, "error": "没装 lark-oapi，先 pip install lark-oapi"})
                return
            state = feishu_sdk.login_async()
            log("飞书授权已发起，等用户在飞书确认")
            self._send(200, {"ok": True, **state})
            return

        if route.path == "/quit":
            # 给「停止本机助手.bat」用：回完响应再关，别让调用方看到连接被掐断。
            self._send(200, {"ok": True})
            threading.Thread(target=request_shutdown, daemon=True).start()
            return

        if route.path != "/config":
            self._send(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            patch = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
            self._send(400, {"ok": False, "error": f"请求体不是合法 JSON：{error}"})
            return

        if not isinstance(patch, dict):
            self._send(400, {"ok": False, "error": "请求体必须是对象"})
            return

        config = json.loads(json.dumps(self.config))
        if isinstance(patch.get("port"), int) and 1024 < patch["port"] < 65535:
            config["port"] = patch["port"]

        for section in ("wechat", "feishu"):
            incoming = patch.get(section)
            if not isinstance(incoming, dict):
                continue
            for key in ("enabled", "sessions", "window", "use_clipboard", "max_messages", "days", "mode", "chats"):
                if key in incoming:
                    config[section][key] = incoming[key]
        if isinstance(config.get("wechat", {}).get("sessions"), list):
            config["wechat"]["sessions"] = [
                item.strip() for item in config["wechat"]["sessions"] if isinstance(item, str) and item.strip()
            ]
        if isinstance(config.get("feishu", {}).get("chats"), list):
            config["feishu"]["chats"] = [
                item.strip() for item in config["feishu"]["chats"] if isinstance(item, str) and item.strip()
            ]
        if config.get("feishu", {}).get("mode") not in ("sdk", "clipboard"):
            config.setdefault("feishu", {})["mode"] = "clipboard"
        if isinstance(config.get("feishu", {}).get("days"), int):
            config["feishu"]["days"] = max(1, min(7, config["feishu"]["days"]))
        # 收集范围只接受 1~7 天，别让人从接口塞个 365 进来。
        if isinstance(config.get("wechat", {}).get("days"), int):
            config["wechat"]["days"] = max(1, min(7, config["wechat"]["days"]))

        try:
            CONFIG_PATH.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as error:
            self._send(500, {"ok": False, "error": f"写配置文件失败：{error}"})
            return

        Handler.config = config
        self.config = config
        log("配置已更新：" + json.dumps(config.get("wechat", {}).get("sessions", []), ensure_ascii=False))
        self._send(200, {"ok": True, "config": config})

    def do_OPTIONS(self) -> None:  # noqa: N802
        try:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
        except Exception:  # noqa: BLE001
            pass

    def log_message(self, fmt: str, *args) -> None:
        # 每个请求都要记一行。以前这行的输出失败会把请求一起带走，现在 log 自己吞掉了。
        try:
            log(fmt % args)
        except Exception:  # noqa: BLE001
            pass


_SERVER: "ThreadingHTTPServer | None" = None


def request_shutdown() -> None:
    """POST /quit 的落地动作：关监听、放端口，进程随后自然退出。"""
    if _SERVER is not None:
        _SERVER.shutdown()


def main() -> int:
    global _SERVER
    config = load_config()


    if "--config" in sys.argv:
        print(str(CONFIG_PATH))
        return 0

    if "--once" in sys.argv:
        days = None
        if "--days" in sys.argv:
            try:
                days = int(sys.argv[sys.argv.index("--days") + 1])
            except (IndexError, ValueError):
                days = None
        result = collect(config, days)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    port = int(config.get("port", 8787))
    Handler.config = config
    # daemon_threads：请求线程不能拖住进程退出。
    # 每个请求再单独兜一层，任何异常都回 JSON（见 Handler.do_GET）。
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    _SERVER = server
    log(f"本机助手已启动：http://127.0.0.1:{port}/today")
    log(f"配置文件：{CONFIG_PATH}")
    ready, why = wx_ready()
    if ready:
        log("微信通道：wxauto4 可用")
    else:
        log(f"微信通道：不可用（{why}）。当前解释器 {sys.executable}")
        log("  换装了 wxauto4 的解释器启动：py -3.13 bridge/notice_bridge.py")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("已停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
