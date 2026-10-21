#!/usr/bin/env python3
"""
WorkBuddy Agent 引擎桥（bridge）

作用：把「CodeBuddy Agent SDK（Python）」包成一个跟 codex app-server 同构的
      JSON-RPC over stdio 服务，让 Codex-Remote-Contact 只换引擎、不动传输层。

协议（每行一个 JSON）：
  网关 -> 桥（请求）
    {"jsonrpc":"2.0","id":<n>,"method":"<m>","params":{...}}
  桥 -> 网关（响应）
    {"jsonrpc":"2.0","id":<n>,"result":{...}} | {"jsonrpc":"2.0","id":<n>,"error":{"message":...}}
  桥 -> 网关（通知，无 id）
    {"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{...}}
    {"jsonrpc":"2.0","method":"turn/completed","params":{...}}
    {"jsonrpc":"2.0","method":"error","params":{...}}

方法表（与 src/codex/client.js 用到的一一对应）：
  initialize            -> {ok, engine, sdk, cli, account}
  thread/start          -> {thread:{id}}
  thread/resume         -> {thread:{id}}
  thread/delete         -> {deleted, transcriptFiles, assetDirs, projectStoreRemoved}
  turn/start            -> {turn:{id}}          之后流式发 delta，最后 turn/completed
  turn/interrupt        -> {ok}
  model/list            -> {data:[{id,...}], nextCursor:null}
  thread/loaded/list    -> {data:[threadId], nextCursor:null}
  shutdown              -> {ok}

隔离模型：一个 thread = 一个 CodeBuddySDKClient = 一个独立 CLI 子进程。
          这天然满足「一个群/一个人锁定一个独立对话」。
"""

from __future__ import annotations

import asyncio
import base64
import glob
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
from typing import Any, Dict, Optional

# 优先使用独立安装的最新版 CLI：`/login` 写入的账号状态与它绑定，且桌面
# WorkBuddy 内置的旧 CLI 可能使用另一套认证存储，导致桌面端已登录而网关仍
# 报 Authentication required。没有独立 CLI 时才回退到桌面端内置版本；仍可
# 用 WB_AGENT_CLI 显式覆盖。
STANDALONE_CLI_PATH = os.path.expanduser("~/.local/bin/codebuddy")
BUNDLED_CLI_PATH = (
    "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
)
DEFAULT_CLI_PATH = (
    STANDALONE_CLI_PATH
    if os.path.isfile(STANDALONE_CLI_PATH) and os.access(STANDALONE_CLI_PATH, os.X_OK)
    else BUNDLED_CLI_PATH
)

# CLI 冷启动期（要拉插件市场、跑产品配置）可能吞掉早期控制请求，
# 所以用较短的单次超时 + 有限次重发，而不是干等一个很长的超时。
CONTROL_TIMEOUT_MS = 10_000
INIT_RETRY_ATTEMPTS = 6
# WorkBuddy 会把视觉输入以内嵌 Base64 JSON 发给模型服务。Base64 会额外膨胀约
# 1/3；如果一次积压了很多普通图片，未约束的请求会在到达模型前触发
# `Request body larger than maxBodyLength limit`。这里把原始图片字节控制在 2 MiB
# 内，必要时只生成本轮临时 JPEG 预览，不修改或删除 QQ 缓存原图。
MAX_PROMPT_IMAGE_RAW_BYTES = 2 * 1024 * 1024
MAX_PROMPT_IMAGE_COUNT = 48
MIN_PROMPT_IMAGE_BYTES = 64 * 1024
SIPS_PATH = "/usr/bin/sips"
MAX_IMAGE_PREPARATION_SECONDS = 40.0
IMAGE_REDUCTION_ATTEMPTS = [
    (1280, 72),
    (1280, 65),
    (1024, 58),
    (768, 50),
    (512, 42),
    (384, 35),
]
# model/list 最多等账号探测多久（网关启动后立刻会拉一次目录）
MODEL_PROBE_WAIT_S = 30.0
# thread_id -> SDK session_id 的落盘映射，桥重启后靠它续接会话
SESSION_MAP_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".session-map.json")

# ---------------------------------------------------------------------------
# 环境隔离：必须在 import SDK 之前做，而且必须用「白名单」而不是「黑名单」。
#
# 实测结论（2026-09-19，反复复现）：
#   宿主会往子进程注入一大批环境变量。只剥 CODEBUDDY_/WORKBUDDY_/ACC_ 前缀
#   是不够的——剩下的这些没有上述前缀，却足以让无头 CLI 误判自己跑在 IDE 宿主里：
#     CLIENT_INFO_IDE_TYPE / CLIENT_INFO_PRODUCT_VERSION / CLIENT_INFO_PRODUCT_NAME
#     CLIENT_INFO_USER_AGENT_EXTENSION / CLIENT_INFO_PLUGIN_NAME / CLAUDE_SESSION_ID
#     ELECTRON_RUN_AS_NODE / GENIE_TRASH_DIR …
#   结果是 CLI 启动流程卡在半路、永远不去读 stdin，SDK 的 initialize 控制请求
#   无论等 60s 还是 180s 都没有回应（日志里连 AgentController.run 都不出现）。
#   同一 venv、同一份代码，把环境白名单化之后 3/3 全部 6~8s 通过。
#
# 另外默认不带 HTTP_PROXY/HTTPS_PROXY：宿主代理端口会随会话轮换，长命子进程
# 抓到死端口就再也连不上。确实需要走代理的，用
#   WB_AGENT_ENV_KEEP=HTTP_PROXY,HTTPS_PROXY,NO_PROXY
# 显式放行。
# ---------------------------------------------------------------------------

# 先取出自己的配置（白名单会把它们一起丢掉）
CLI_PATH = os.environ.get("WB_AGENT_CLI", DEFAULT_CLI_PATH)
FULL_ACCESS_ROOTS_RAW = os.environ.get("WB_AGENT_FULL_ACCESS_ROOTS", "")
_EXTRA_KEEP = {
    k.strip()
    for k in os.environ.get("WB_AGENT_ENV_KEEP", "").split(",")
    if k.strip()
}

ENV_WHITELIST = {
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR",
    "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING", "TZ", "PWD",
    "CODEX_REMOTE_CONTACT_QQ_MCP_ENDPOINT", "CODEX_REMOTE_CONTACT_QQ_MCP_SECRET",
} | _EXTRA_KEEP

_DROPPED_ENV = [k for k in os.environ if k not in ENV_WHITELIST]
_KEPT_ENV = {k: v for k, v in os.environ.items() if k in ENV_WHITELIST}
os.environ.clear()
os.environ.update(_KEPT_ENV)
os.environ["CODEBUDDY_CODE_PATH"] = CLI_PATH

# 与网关读同一份工作区设置；SDK 默认不加载任何本地配置，必须显式开
DEFAULT_SETTING_SOURCES = ["user", "project", "local"]

# 本账号实测白名单（17 个）。model/list 会优先返回运行时探测结果；
# 这里只是探测完成前的兜底，所以不要塞账号上不存在的名字，否则 UI 里会出现
# 一选就报错的模型。
FALLBACK_MODELS = [
    "auto",
    "hy4-preview", "hy4-preview-f", "hy3", "hy3-x",
    "deepseek-v4.1-flash", "deepseek-v4-pro",
    "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5v-turbo",
    "minimax-m3", "kimi-k3-1", "kimi-k2.8-preview", "kimi-k2.7", "kimi-k2.6",
]

# Codex 的沙箱语汇 -> WorkBuddy 的权限模式
SANDBOX_TO_PERMISSION = {
    "readOnly": "dontAsk",
    "read-only": "dontAsk",
    "workspaceWrite": "acceptEdits",
    "workspace-write": "acceptEdits",
    "dangerFullAccess": "bypassPermissions",
    "danger-full-access": "bypassPermissions",
}

# 当前 WorkBuddy CLI --help 实际公开的全部 --effort 值。Python SDK 0.3.261
# 的 Literal 仍少了 minimal/max，但运行时不做类型拦截，CLI 能原样接收。
EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]
DEFAULT_EFFORT = "auto"
# auto 表示不传 --effort，交给当前模型决定；只保留 Codex 历史档位的安全回退。
EFFORT_ALIASES = {"ultra": "max", "none": None, "auto": None}

READ_ONLY_TOOLS = ["Read", "WebFetch", "WebSearch", "Glob", "Grep"]


def full_access_roots() -> list[str]:
    """Return existing host roots projected into a full-access WorkBuddy session.

    ``bypassPermissions`` only skips approval prompts.  WorkBuddy still treats the
    cwd as its sole trusted filesystem root unless ``--add-dir`` or
    ``permissions.additionalDirectories`` is supplied.  The gateway needs both
    the user's home (Desktop/Documents/etc.) and mounted volumes (NAS/removable
    disks), while keeping ordinary workspace sessions unchanged.
    """
    configured = [item.strip() for item in FULL_ACCESS_ROOTS_RAW.split(os.pathsep) if item.strip()]
    candidates = configured or [os.path.expanduser("~"), "/Volumes"]
    roots: list[str] = []
    for candidate in candidates:
        path = os.path.realpath(os.path.abspath(os.path.expanduser(candidate)))
        if os.path.isdir(path) and path not in roots:
            roots.append(path)
    return roots


def session_extra_args(session: "Session") -> Dict[str, str]:
    args: Dict[str, str] = {"autocompact": session.context_token_limit}
    # Do not pass WorkBuddy CLI --json-schema here.  Some otherwise capable
    # models answer the AUTO notice correctly but never invoke the CLI's
    # synthetic StructuredOutput tool.  The CLI then keeps injecting
    # "You MUST call StructuredOutput" and loops until the gateway turn
    # timeout.  The gateway already validates the returned JSON against its
    # own contract and performs one corrective retry, so the CLI constraint is
    # both redundant and less reliable than the existing validation path.
    if session.permission_mode == "bypassPermissions":
        args["settings"] = json.dumps(
            {"permissions": {"additionalDirectories": full_access_roots()}},
            ensure_ascii=False,
            separators=(",", ":"),
        )
    return args

def log(*args: Any) -> None:
    """日志一律走 stderr，绝不污染 stdout 的协议流。"""
    print("[bridge]", *args, file=sys.stderr, flush=True)


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def normalize_effort(value: Any) -> Optional[str]:
    """把网关传来的档位归一化成 CLI 认得的取值；认不出就返回 None（不传 flag）。

    effort 是 CLI 的启动参数（--effort），所以它属于「会话级」设置：
    中途改变必须重建 client 才能生效。
    """
    if value in (None, "", "N/A"):
        return None
    text = str(value).strip().lower()
    if text in EFFORTS:
        return text
    if text in EFFORT_ALIASES:
        mapped = EFFORT_ALIASES[text]
        log(f"档位 {value!r} 按别名映射为 {mapped or 'CLI 默认'}")
        return mapped
    log(f"档位 {value!r} 无法识别，本轮不传 --effort（走 CLI 默认）")
    return None


def result_usage(message: Any) -> Dict[str, Any]:
    """Forward SDK fields verbatim. Missing cache data is unknown, not zero.

    Do not derive billed credits or cache-miss tokens from ambiguous SDK fields.
    """
    usage = getattr(message, "usage", None)
    def number(key: str):
        value = usage.get(key) if isinstance(usage, dict) else getattr(usage, key, None)
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None
    return {
        "inputTokens": number("input_tokens"), "outputTokens": number("output_tokens"),
        "cachedTokens": number("cache_read_input_tokens"),
        "cacheCreationTokens": number("cache_creation_input_tokens"),
        "modelCalls": getattr(message, "num_turns", None),
    }


def normalize_context_limit(value: Any) -> str:
    """归一化为 CLI --autocompact 的真实取值：auto 或 100K..1M。"""
    if value in (None, "", "auto"):
        return "auto"
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return "auto"
    return str(min(1_000_000, max(100_000, numeric)))


def normalize_working_mode(_value: Any) -> str:
    """The headless gateway exposes one non-interactive working mode: Agent."""
    return "agent"


def normalize_system_prompt(value: Any) -> str:
    """Keep the gateway-owned stable persona bounded and free of control bytes."""
    text = str(value or "").replace("\x00", "").strip()
    return text[:12_000]


def normalize_output_schema(value: Any) -> Optional[str]:
    """Return stable compact JSON for WorkBuddy CLI --json-schema."""
    if not value:
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"outputSchema 不是有效 JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise RuntimeError("outputSchema 必须是 JSON object")
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Turn:
    """一次进行中的模型轮次"""

    def __init__(self, thread_id: str, turn_id: str, group_id: str) -> None:
        self.thread_id = thread_id
        self.turn_id = turn_id
        self.group_id = group_id
        self.text = ""
        self.cancelled = False
        self.tool_attempts: set[str] = set()
        self.done = asyncio.Event()
        self.task: Optional[asyncio.Task] = None


class WorkBuddyModelFailure(RuntimeError):
    """A terminal upstream model error, never a successful QQ turn."""


def model_message_error(message: Any) -> Optional[str]:
    if getattr(message, "is_error", False) or str(getattr(message, "subtype", "")).startswith("error"):
        errors = getattr(message, "errors", None) or []
        return "; ".join(map(str, errors)) or str(getattr(message, "result", None) or "WorkBuddy 模型请求失败")
    error = getattr(message, "error", None)
    if error:
        return str(error)
    return None


class Session:
    """一个 thread = 一个 SDK client = 一个独立子进程"""

    def __init__(self, thread_id: str, cwd: str) -> None:
        self.thread_id = thread_id
        self.cwd = cwd
        self.client: Any = None
        self.model: Optional[str] = None
        self.effort: Optional[str] = None
        self.permission_mode: str = "dontAsk"
        self.working_mode: str = "agent"
        self.context_token_limit: str = "auto"
        self.system_prompt: str = ""
        self.output_schema: Optional[str] = None
        self.source_read_only: bool = False
        self.ephemeral: bool = False
        # SDK 自己生成的真实会话 id（ResultMessage.session_id）。
        # 注意：thread_id 是桥这边自己编的，不能拿去当 resume 参数 —— 用它续接
        # CLI 不认识、整轮静默空返回（这也是 QQ 侧「无法安全回复」空话术的根因）。
        self.sdk_session_id: Optional[str] = None
        self.retired_sdk_session_ids: set[str] = set()
        self.lock = asyncio.Lock()
        self.closed = False


class Bridge:
    def __init__(self) -> None:
        self.sessions: Dict[str, Session] = {}
        self.turns: Dict[str, Turn] = {}
        self.active_by_group: Dict[str, Turn] = {}
        self.models: list = list(FALLBACK_MODELS)
        self.account: Dict[str, Any] = {}
        self.sdk_version = "unknown"
        self._loaded_models = False
        self.probe_task: Optional[asyncio.Task] = None
        # The SDK occasionally acknowledges interrupt without ending its response
        # iterator.  Keep both waits bounded so one stale turn cannot block a QQ
        # target forever.
        self.interrupt_grace_seconds = 2.0
        self.force_cancel_wait_seconds = 2.0
        # thread_id -> SDK session_id 的落盘映射：桥/网关重启后还能续接会话
        self._session_map: Dict[str, str] = self._load_session_map()

    # ---------------- 生命周期 ----------------

    async def initialize(self, params: Dict[str, Any]) -> Dict[str, Any]:
        global _sdk
        try:
            import codebuddy_agent_sdk as sdk

            _sdk = sdk
            self.sdk_version = getattr(sdk, "__version__", "unknown")
        except Exception as exc:  # pragma: no cover - 环境缺依赖才会走到
            raise RuntimeError(f"codebuddy-agent-sdk 不可用: {exc}") from exc

        log(f"SDK {self.sdk_version} / CLI {CLI_PATH}")
        log(f"环境白名单：放行 {len(_KEPT_ENV)} 个，丢弃 {len(_DROPPED_ENV)} 个宿主注入变量")
        # CLI 是 #!/usr/bin/env node 脚本，PATH 里必须有 node
        if not any(
            os.path.exists(os.path.join(d, "node"))
            for d in os.environ.get("PATH", "").split(":")
            if d
        ):
            log("警告：PATH 里找不到 node，CLI 可能起不来（把 node 目录加进 PATH，或用 WB_AGENT_ENV_KEEP 放行）")
        # 顺带把账号与模型白名单捞一次（失败不影响启动）
        self.probe_task = asyncio.create_task(self._probe_account())
        return {
            "ok": True,
            "engine": "workbuddy",
            "sdk": self.sdk_version,
            "cli": CLI_PATH,
        }

    async def _probe_account(self) -> None:
        """用一次极短的会话拿账号信息与模型白名单，失败就静默保留兜底值。"""
        if self._loaded_models:
            return
        self._loaded_models = True
        try:
            from codebuddy_agent_sdk import CodeBuddyAgentOptions, query
        except Exception:
            return
        try:
            # 故意传一个不存在的模型：SDK 会抛错并列出本账号可用模型
            opts = CodeBuddyAgentOptions(
                cwd=os.getcwd(), model="__probe__", permission_mode="plan",
                request_timeout_ms=CONTROL_TIMEOUT_MS,
            )
            async for _ in query(prompt="ping", options=opts):
                pass
        except Exception as exc:
            text = str(exc)
            harvested = []
            for line in text.splitlines():
                line = line.strip()
                if line.startswith("- "):
                    harvested.append(line[2:].strip())
            if harvested:
                self.models = harvested
                log(f"模型白名单已探测到 {len(harvested)} 个")
            if "not found" not in text:
                log(f"账号探测异常（忽略）: {text[:200]}")

    # ---------------- thread_id -> SDK session_id 映射 ----------------

    @staticmethod
    def _load_session_map() -> Dict[str, str]:
        try:
            with open(SESSION_MAP_PATH, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return {str(k): str(v) for k, v in (data or {}).items() if v}
        except Exception:
            return {}

    def _remember_session_id(self, thread_id: str, sdk_session_id: str) -> None:
        if not sdk_session_id or sdk_session_id == thread_id:
            return
        if self._session_map.get(thread_id) == sdk_session_id:
            return
        self._session_map[thread_id] = sdk_session_id
        self._save_session_map()

    def _save_session_map(self, strict: bool = False) -> None:
        temporary = f"{SESSION_MAP_PATH}.tmp-{os.getpid()}"
        try:
            with open(temporary, "w", encoding="utf-8") as fh:
                json.dump(self._session_map, fh, ensure_ascii=False, indent=1)
            os.replace(temporary, SESSION_MAP_PATH)
        except Exception as exc:
            log(f"会话映射写盘失败（忽略）: {exc}")
            try:
                os.unlink(temporary)
            except OSError:
                pass
            if strict:
                raise

    @staticmethod
    def _project_store_dir(cwd: str) -> str:
        """Mirror WorkBuddy PathUtils.compressPath(canonical cwd)."""
        canonical = os.path.realpath(os.path.abspath(cwd))
        compressed = re.sub(r"-+", "-", re.sub(r"[/\\:]", "-", canonical)).strip("-")
        return os.path.join(os.path.expanduser("~/.codebuddy/projects"), compressed)

    def _ensure_resume_history(self, cwd: str, sdk_session_id: Optional[str]) -> None:
        """Copy an existing session transcript into the cwd-scoped WorkBuddy store.

        WorkBuddy resolves ``--resume`` inside the current cwd's project store.  The
        gateway historically created every session in the repository root and later
        launched group turns in a per-group workspace, so the same valid session id
        became invisible.  Keep the original transcript and make an atomic copy in the
        stable group workspace store before resuming it there.
        """
        if not sdk_session_id:
            return
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_:-]*", sdk_session_id):
            raise RuntimeError("WorkBuddy SDK session id 格式无效")
        projects_dir = os.path.expanduser("~/.codebuddy/projects")
        target_dir = self._project_store_dir(cwd)
        target_file = os.path.join(target_dir, f"{sdk_session_id}.jsonl")
        if os.path.isfile(target_file):
            return
        candidates = [
            path for path in glob.glob(os.path.join(projects_dir, "*", f"{sdk_session_id}.jsonl"))
            if os.path.abspath(path) != os.path.abspath(target_file)
        ]
        if not candidates:
            return
        source_file = max(candidates, key=os.path.getmtime)
        os.makedirs(target_dir, exist_ok=True)
        temporary = f"{target_file}.migrating-{os.getpid()}"
        shutil.copy2(source_file, temporary)
        os.replace(temporary, target_file)
        source_assets = os.path.join(os.path.dirname(source_file), sdk_session_id)
        target_assets = os.path.join(target_dir, sdk_session_id)
        if os.path.isdir(source_assets) and not os.path.exists(target_assets):
            shutil.copytree(source_assets, target_assets)
        log(f"已把 SDK 会话 {sdk_session_id} 复制到当前工作区会话库（原记录保留）")

    @staticmethod
    async def _disconnect_client(client: Any) -> bool:
        """Disconnect an SDK client and force-stop its CLI if SDK cleanup stalls."""
        transport = getattr(client, "_transport", None)
        process = getattr(transport, "_process", None)
        disconnected = False
        try:
            await asyncio.wait_for(client.disconnect(), timeout=8.0)
            disconnected = True
        except Exception as exc:
            log(f"client disconnect 异常，改为终止 CLI: {exc}")
        if process is not None and getattr(process, "returncode", None) is None:
            try:
                process.terminate()
            except ProcessLookupError:
                return True
            try:
                await asyncio.wait_for(process.wait(), timeout=5.0)
                return True
            except Exception:
                try:
                    process.kill()
                except ProcessLookupError:
                    return True
                try:
                    await asyncio.wait_for(process.wait(), timeout=5.0)
                    return True
                except Exception as exc:
                    log(f"无法确认失效 CLI 已退出: {exc}")
                    return False
        return disconnected or (process is not None and process.returncode is not None)

    @staticmethod
    def _is_transport_failure(exc: BaseException) -> bool:
        """Return whether an exception means the SDK/CLI transport is unusable.

        WorkBuddy keeps one long-lived CLI transport per persistent conversation.
        If that process closes, reusing the cached SDK client only turns the first
        ``CLIConnectionError`` into an endless series of ``BrokenResourceError``
        failures.  Inspect chained exceptions as AnyIO often wraps the original
        socket/pipe error.
        """
        failure_names = {
            "CLIConnectionError",
            "BrokenResourceError",
            "ClosedResourceError",
            "EndOfStream",
            "ConnectionResetError",
            "BrokenPipeError",
            "EOFError",
        }
        failure_fragments = (
            "connection closed",
            "connection lost",
            "connection reset",
            "broken pipe",
            "broken resource",
            "closed resource",
            "transport closed",
            "stream closed",
            "socket is closed",
            "socket closed",
            "socket hang up",
        )
        current: Optional[BaseException] = exc
        seen: set[int] = set()
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            if type(current).__name__ in failure_names:
                return True
            message = str(current).strip().lower()
            if any(fragment in message for fragment in failure_fragments):
                return True
            current = current.__cause__ or current.__context__
        return False

    @classmethod
    def _is_transient_upstream_failure(cls, exc: BaseException) -> bool:
        """Only explicit temporary service/transport failures qualify for recovery.

        SDK ExecutionError is also used for authentication and invalid requests.
        Never make that entire exception class retryable, or infer retry safety
        from a generic execution failure.
        """
        current: Optional[BaseException] = exc
        seen: set[int] = set()
        statuses: set[str] = set()
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            if type(current).__name__ == "AuthenticationError":
                return False
            errors = getattr(current, "errors", None)
            for text in [str(current), *(errors if isinstance(errors, (list, tuple)) else [])]:
                statuses.update(re.findall(
                    r"(?:\b(?:http|status(?:\s*code)?|(?:api\s*)?error)\s*[:=]?\s*|\A\s*)([45]\d\d)\b",
                    str(text), re.IGNORECASE,
                ))
            current = current.__cause__ or current.__context__
        if any(status.startswith("4") for status in statuses):
            return False
        return bool(statuses & {"502", "503", "504"}) or cls._is_transport_failure(exc)

    async def _retire_client(self, session: Session, client: Any, reason: BaseException) -> bool:
        """Drop a dead cached client while preserving the persistent session id."""
        if client is None:
            return False
        if session.client is client:
            session.client = None
        session.closed = False
        log(f"检测到 WorkBuddy 连接失效，回收旧 client，保留原会话续接：{reason}")
        try:
            return await self._disconnect_client(client)
        except Exception as cleanup_exc:  # cleanup must not hide the real failure
            log(f"回收失效 client 时出现异常（忽略）: {cleanup_exc}")
            return False

    async def _send_prompt_resilient(
        self,
        session: Session,
        client: Any,
        prompt: str,
        image_paths: list,
    ) -> Any:
        """Send once, reconnecting and resending only if the transport was already dead.

        This recovery is deliberately limited to ``query()``.  At this point the
        SDK has not accepted the prompt when it reports a closed transport, so one
        reconnect-and-resend is safe.  A connection loss while streaming a reply is
        handled by retiring the client for the next turn without replaying the
        current turn, which avoids duplicate Agent actions.
        """
        try:
            await self._send_prompt(client, prompt, image_paths)
            return client
        except Exception as exc:
            if not self._is_transport_failure(exc):
                raise
            if not await self._retire_client(session, client, exc):
                raise

        replacement = await self._make_client(session, resume=session.sdk_session_id)
        try:
            await self._send_prompt(replacement, prompt, image_paths)
            log("WorkBuddy 已重新连接，并在原持久会话中接住本轮提示")
            return replacement
        except Exception as exc:
            if self._is_transport_failure(exc):
                await self._retire_client(session, replacement, exc)
            raise

    @staticmethod
    def _is_legacy_plan_mode_error(exc: BaseException) -> bool:
        message = str(exc).strip().lower()
        return "exitplanmode" in message and (
            "not found in agent cli" in message
            or "does not exist in the current tool set" in message
        )

    async def _migrate_legacy_plan_session(self, session: Session) -> None:
        """Fork one legacy Plan transcript and exit Plan without exposing QQ tools.

        Older gateway versions mapped read-only turns to WorkBuddy Plan mode.  A
        resumed transcript keeps that internal mode even when the new process is
        launched as Agent, then tries to call ``ExitPlanMode``.  Current normal
        turns intentionally do not expose that mode tool.  Migrate only after the
        exact compatibility error: fork the transcript, allow one ExitPlanMode
        call, restore the session's real permission mode, then remap the logical
        gateway thread to the repaired SDK session.
        """
        from codebuddy_agent_sdk import (
            CodeBuddyAgentOptions, CodeBuddySDKClient, PermissionResultAllow,
            PermissionResultDeny, ResultMessage,
        )

        old_sdk_id = session.sdk_session_id
        if not old_sdk_id:
            raise RuntimeError("旧 Plan 会话缺少可迁移的 SDK session id")

        async def allow_exit_plan(name: str, _input: Dict[str, Any], _options: Any):
            if name == "ExitPlanMode":
                return PermissionResultAllow()
            return PermissionResultDeny(message="Legacy mode migration permits only ExitPlanMode")

        extra_args = session_extra_args(session)
        extra_args["permission-mode-before-plan"] = session.permission_mode
        options = CodeBuddyAgentOptions(
            cwd=session.cwd,
            model=session.model,
            effort=session.effort,
            permission_mode="default",
            tools=["ExitPlanMode"],
            mcp_servers={},
            setting_sources=DEFAULT_SETTING_SOURCES,
            include_partial_messages=False,
            request_timeout_ms=CONTROL_TIMEOUT_MS,
            extra_args=extra_args,
            resume=old_sdk_id,
            fork_session=True,
            can_use_tool=allow_exit_plan,
        )
        repair_client = CodeBuddySDKClient(options=options)
        repaired_sdk_id = None
        try:
            await repair_client.connect()
            await repair_client.query(
                "这是旧会话模式迁移。只调用 ExitPlanMode 退出残留 Plan 状态并恢复 Agent。"
                "不要发送消息。不要读取或修改文件。不要执行其他动作。"
            )
            async for message in repair_client.receive_response():
                if isinstance(message, ResultMessage):
                    repaired_sdk_id = getattr(message, "session_id", None)
        finally:
            await self._disconnect_client(repair_client)

        if not repaired_sdk_id or repaired_sdk_id == old_sdk_id:
            raise RuntimeError("旧 Plan 会话迁移没有生成新的 Agent session")
        session.retired_sdk_session_ids.add(old_sdk_id)
        session.sdk_session_id = repaired_sdk_id
        session.client = None
        self._remember_session_id(session.thread_id, repaired_sdk_id)
        log(
            f"旧 Plan 会话已迁移到 Agent thread={session.thread_id} "
            f"sdk={old_sdk_id}->{repaired_sdk_id}"
        )

    # ---------------- thread ----------------

    async def _make_client(self, session: Session, resume: Optional[str] = None):
        from codebuddy_agent_sdk import (
            AppendSystemPrompt, CodeBuddyAgentOptions, CodeBuddySDKClient,
            HookMatcher, PermissionResultAllow, PermissionResultDeny,
        )

        async def can_use_tool(name: str, _input: Dict[str, Any], _options: Any):
            # This approves only our local MCP route. The Node gateway still
            # validates the active turn, OWNER/poke scope and exact sticker ID.
            requested = _input.get("toolName") if name == "DeferExecuteTool" else name
            if isinstance(requested, str) and requested.startswith("mcp__qq_gateway__"):
                return PermissionResultAllow()
            return PermissionResultDeny(message="No permission handler provided")

        async def post_compact_hook(input_data: Dict[str, Any], _tool_use_id: Optional[str], _context: Dict[str, Any]):
            """Tell the gateway that the next real QQ turn must refresh fixed instructions."""
            emit({
                "jsonrpc": "2.0",
                "method": "thread/compacted",
                "params": {
                    "threadId": session.thread_id,
                    "trigger": str(input_data.get("trigger") or "auto"),
                },
            })
            return {"continue_": True, "suppressOutput": True}

        async def pre_compact_hook(input_data: Dict[str, Any], _tool_use_id: Optional[str], _context: Dict[str, Any]):
            """Give a bounded compaction grace period before the SDK stops yielding output."""
            emit({
                "jsonrpc": "2.0",
                "method": "thread/compacting",
                "params": {
                    "threadId": session.thread_id,
                    "trigger": str(input_data.get("trigger") or "auto"),
                },
            })
            return {"continue_": True, "suppressOutput": True}

        async def pre_tool_hook(input_data: Dict[str, Any], _tool_use_id: Optional[str], _context: Dict[str, Any]):
            turn = next((item for item in self.turns.values()
                         if item.thread_id == session.thread_id and not item.cancelled), None)
            if turn is None:
                return {"continue_": False, "stopReason": "本轮已停止，不能再调用工具"}
            name = str(input_data.get("tool_name") or "unknown")
            if name == "DeferExecuteTool":
                name = str((input_data.get("tool_input") or {}).get("toolName") or name)
            turn.tool_attempts.add(name)
            emit({"jsonrpc": "2.0", "method": "turn/toolAttempt", "params": {
                "threadId": turn.thread_id, "turnId": turn.turn_id, "name": name}})
            return {"continue_": True}

        self._ensure_resume_history(session.cwd, resume)
        extra_args = session_extra_args(session)
        mcp_endpoint = os.environ.get("CODEX_REMOTE_CONTACT_QQ_MCP_ENDPOINT", "")
        mcp_secret = os.environ.get("CODEX_REMOTE_CONTACT_QQ_MCP_SECRET", "")
        mcp_servers = {}
        # Read-only scheduled QQ Space turns still need the scoped gateway MCP.
        # The Node active-turn context denies tools outside that scheduled task.
        if not session.ephemeral and mcp_endpoint and mcp_secret:
            mcp_servers["qq_gateway"] = {
                "command": shutil.which("node") or "node",
                "args": [os.path.join(os.path.dirname(__file__), "qq-mcp-stdio.mjs"), session.thread_id],
                # QQ tool schemas are small and static. Keep the entire scoped
                # catalog inline across chat/Space turns so discovery does not
                # add new definitions in front of the cached transcript. AUTO
                # still advertises only its scoped read-only tools below.
                "defer_loading": False,
                "tools": {},
                "env": {
                    "CODEX_REMOTE_CONTACT_QQ_MCP_ENDPOINT": mcp_endpoint,
                    "CODEX_REMOTE_CONTACT_QQ_MCP_SECRET": mcp_secret,
                    **({"CODEX_REMOTE_CONTACT_QQ_MCP_SOURCE_ONLY": "1"} if session.source_read_only else {}),
                },
            }
        system_parts = [session.system_prompt] if session.system_prompt else []
        opts = CodeBuddyAgentOptions(
            cwd=session.cwd,
            model=session.model,
            effort=session.effort,
            permission_mode=session.permission_mode,
            # --tools selects built-in tools; MCP tools are added by the server
            # manager. AUTO needs no built-ins: its scoped source tools are
            # already inline, so legacy discovery only teaches a stale path.
            tools=[] if session.source_read_only
            else READ_ONLY_TOOLS if session.permission_mode == "dontAsk" else None,
            mcp_servers=mcp_servers,
            system_prompt=AppendSystemPrompt(append="\n\n".join(system_parts))
            if system_parts else None,
            hooks={
                "PreToolUse": [HookMatcher(hooks=[pre_tool_hook], timeout=5.0)],
                "PreCompact": [HookMatcher(hooks=[pre_compact_hook], timeout=5.0)],
                "PostCompact": [HookMatcher(hooks=[post_compact_hook], timeout=5.0)]
            },
            can_use_tool=can_use_tool,
            setting_sources=DEFAULT_SETTING_SOURCES,
            include_partial_messages=True,
            request_timeout_ms=CONTROL_TIMEOUT_MS,
            extra_args=extra_args,
        )
        if resume:
            # 跨进程续接历史会话。resume 必须是 SDK 自己生成的 session_id
            # （从 ResultMessage.session_id 拿），不是桥这边的 thread_id。
            opts.resume = resume
        client = CodeBuddySDKClient(options=opts)
        await client.connect()
        session.client = client
        return client

    async def thread_start(self, params: Dict[str, Any]) -> Dict[str, Any]:
        cwd = params.get("cwd") or os.getcwd()
        model = params.get("model") or None
        if model in ("", "N/A"):
            model = None
        thread_id = params.get("threadId") or str(uuid.uuid4())
        session = Session(thread_id, cwd)
        session.ephemeral = bool(params.get("ephemeral"))
        session.model = model
        session.effort = normalize_effort(params.get("effort"))
        session.context_token_limit = normalize_context_limit(params.get("contextTokenLimit"))
        session.working_mode = normalize_working_mode(params.get("workingMode"))
        session.system_prompt = normalize_system_prompt(params.get("systemPrompt"))
        session.permission_mode = SANDBOX_TO_PERMISSION.get(
            str(params.get("sandbox") or "readOnly"), "dontAsk"
        )
        log(
            f"thread/start id={thread_id} cwd={cwd} model={model} effort={session.effort or 'auto'} "
            f"context={session.context_token_limit} mode={session.working_mode}"
        )
        await self._make_client(session)
        self.sessions[thread_id] = session
        return {"thread": {"id": thread_id}}

    async def thread_delete(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Remove one exact session and its history after explicit gateway authorization."""
        thread_id = str(params.get("threadId") or "")
        if not thread_id:
            raise RuntimeError("thread/delete 缺少 threadId")
        delete_persistent = bool(params.get("deletePersistent"))
        requested_ephemeral = bool(params.get("ephemeral"))
        session = self.sessions.get(thread_id)
        if session is None:
            # The bridge may have restarted between turn completion and cleanup.
            # Persistent deletion is accepted only through the dedicated flag;
            # disposable sessions additionally require the trusted label prefix.
            if not delete_persistent and (not requested_ephemeral or not thread_id.startswith("sticker-label-")):
                if thread_id not in self._session_map:
                    return {
                        "deleted": True,
                        "threadId": thread_id,
                        "transcriptFiles": 0,
                        "assetDirs": 0,
                        "projectStoreRemoved": False,
                    }
                raise RuntimeError("找不到可删除的会话实例，拒绝按普通 thread id 清理")
            cwd = str(params.get("cwd") or "")
            if not cwd:
                raise RuntimeError("桥重启后的会话清理缺少 cwd")
            session = Session(thread_id, cwd)
            session.ephemeral = requested_ephemeral
            session.sdk_session_id = self._session_map.get(thread_id)
        if not session.ephemeral and not delete_persistent:
            raise RuntimeError("持久会话删除缺少网关明确授权")
        if bool(params.get("purgeProject")) and not session.ephemeral:
            raise RuntimeError("持久会话不得删除整个项目缓存目录")
        active = [turn for turn in self.turns.values() if turn.thread_id == thread_id]
        if active:
            raise RuntimeError("会话仍有进行中的轮次，暂不能删除")

        if session.client is not None:
            await self._disconnect_client(session.client)
            session.client = None
        session.closed = True

        sdk_session_id = session.sdk_session_id or self._session_map.get(thread_id)
        if sdk_session_id and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_:-]*", sdk_session_id):
            raise RuntimeError("WorkBuddy SDK session id 格式无效，拒绝清理")

        projects_root = os.path.realpath(os.path.expanduser("~/.codebuddy/projects"))
        transcript_files = 0
        asset_dirs = 0
        if sdk_session_id and os.path.isdir(projects_root):
            for project_dir in glob.glob(os.path.join(projects_root, "*")):
                project_real = os.path.realpath(project_dir)
                if os.path.commonpath([projects_root, project_real]) != projects_root:
                    continue
                transcript = os.path.join(project_real, f"{sdk_session_id}.jsonl")
                assets = os.path.join(project_real, sdk_session_id)
                if os.path.isfile(transcript):
                    os.unlink(transcript)
                    transcript_files += 1
                if os.path.isdir(assets):
                    shutil.rmtree(assets)
                    asset_dirs += 1

        project_store_removed = False
        if bool(params.get("purgeProject")):
            project_store = os.path.realpath(self._project_store_dir(session.cwd))
            if os.path.commonpath([projects_root, project_store]) != projects_root or project_store == projects_root:
                raise RuntimeError("临时会话项目缓存目录超出允许范围，拒绝清理")
            if os.path.isdir(project_store):
                shutil.rmtree(project_store)
                project_store_removed = True

        self.sessions.pop(thread_id, None)
        self._session_map.pop(thread_id, None)
        self._save_session_map(strict=True)
        log(
            f"thread/delete id={thread_id} transcripts={transcript_files} "
            f"assets={asset_dirs} project={project_store_removed}"
        )
        return {
            "deleted": True,
            "threadId": thread_id,
            "transcriptFiles": transcript_files,
            "assetDirs": asset_dirs,
            "projectStoreRemoved": project_store_removed,
        }

    async def thread_resume(self, params: Dict[str, Any]) -> Dict[str, Any]:
        thread_id = str(params.get("threadId") or "")
        if not thread_id:
            raise RuntimeError("thread/resume 缺少 threadId")
        cwd = params.get("cwd") or os.getcwd()
        model = params.get("model") or None
        if model in ("", "N/A"):
            model = None
        session = self.sessions.get(thread_id)
        if session is None:
            session = Session(thread_id, cwd)
            self.sessions[thread_id] = session
        elif any(turn.thread_id == thread_id for turn in self.turns.values()):
            # The active turn owns the SDK stream. Apply new launch parameters
            # on its next turn instead of disconnecting a client mid-compaction.
            log(f"thread/resume deferred until active turn completes id={thread_id}")
            return {"thread": {"id": thread_id}, "deferred": True}
        next_model = model if "model" in params else session.model
        next_effort = normalize_effort(params.get("effort")) if "effort" in params else session.effort
        next_context = normalize_context_limit(params.get("contextTokenLimit"))
        next_mode = normalize_working_mode(params.get("workingMode"))
        next_system_prompt = normalize_system_prompt(params.get("systemPrompt"))
        next_permission = SANDBOX_TO_PERMISSION.get(
            str(params.get("threadSandbox") or params.get("sandbox") or "readOnly"),
            session.permission_mode,
        )
        launch_changed = any([
            cwd != session.cwd,
            next_model != session.model,
            next_effort != session.effort,
            next_context != session.context_token_limit,
            next_mode != session.working_mode,
            next_system_prompt != session.system_prompt,
            next_permission != session.permission_mode,
        ])
        if launch_changed and session.client is not None:
            log("会话参数已变化，重建 client 并续接同一 thread")
            await self._disconnect_client(session.client)
            session.client = None
            session.closed = False
        session.cwd = cwd
        session.model = next_model
        session.effort = next_effort
        session.context_token_limit = next_context
        session.working_mode = next_mode
        session.system_prompt = next_system_prompt
        session.permission_mode = next_permission
        # 已有活着的 client 就直接复用。没有 client 时这里只登记会话，不提前
        # 拉起 CLI；真正收到 turn/start 后再在最终 cwd 中续接，避免预锁线程时先
        # 在仓库根目录启动、随后切换群工作区造成重复进程与 SessionNotFound。
        if session.client is None or session.closed:
            sdk_id = session.sdk_session_id or self._session_map.get(thread_id)
            if sdk_id and sdk_id != thread_id:
                session.sdk_session_id = sdk_id
                log(f"thread/resume id={thread_id} cwd={cwd} model={session.model} 已登记 SDK 会话 {sdk_id}")
            else:
                log(f"thread/resume id={thread_id} cwd={cwd} model={session.model} 无已知 SDK 会话")
            session.closed = False
        return {"thread": {"id": thread_id}}

    # ---------------- turn ----------------

    async def turn_start(self, params: Dict[str, Any]) -> Dict[str, Any]:
        thread_id = str(params.get("threadId") or "")
        group_id = str(params.get("groupId") or f"thread:{thread_id}")
        session = self.sessions.get(thread_id)
        if session is None:
            raise RuntimeError(f"未知 thread: {thread_id}")
        if group_id in self.active_by_group:
            raise RuntimeError(f"目标 {group_id} 已有进行中的轮次")

        turn_id = str(uuid.uuid4())
        turn = Turn(thread_id, turn_id, group_id)
        self.turns[turn_id] = turn
        self.active_by_group[group_id] = turn
        log(f"turn/start turn={turn_id} group={group_id} thread={thread_id}")
        turn.task = asyncio.create_task(self._run_turn(turn, session, params))
        return {"turn": {"id": turn_id, "toolTracking": True}}

    async def _run_turn(
        self, turn: Turn, session: Session, params: Dict[str, Any]
    ) -> None:
        from codebuddy_agent_sdk import AssistantMessage, ErrorMessage, ResultMessage, TextBlock

        prompt = str(params.get("prompt") or "")
        image_paths = params.get("imagePaths") or []
        model = params.get("model") or None
        if model in ("", "N/A"):
            model = None
        permission_mode = SANDBOX_TO_PERMISSION.get(
            str(params.get("turnSandbox", {}).get("type") if isinstance(params.get("turnSandbox"), dict)
                else params.get("turnSandbox") or "readOnly"),
            session.permission_mode,
        )
        incoming_context = normalize_context_limit(params.get("contextTokenLimit"))
        incoming_mode = normalize_working_mode(params.get("workingMode"))
        incoming_cwd = str(params.get("cwd") or session.cwd)
        incoming_output_schema = normalize_output_schema(params.get("outputSchema"))
        incoming_source_read_only = bool(params.get("sourceReadOnly"))
        incoming_system_prompt = normalize_system_prompt(params.get("systemPrompt"))
        refresh_client = bool(params.get("refreshClientBeforeTurn"))
        client = None

        try:
            async with session.lock:
                # 档位是 CLI 启动参数（--effort），热改不了：变了就重建 client 并续接同一 thread
                incoming_effort = normalize_effort(params.get("effort"))
                launch_changed = any([
                    model != session.model,
                    incoming_effort != session.effort,
                    incoming_context != session.context_token_limit,
                    incoming_mode != session.working_mode,
                    incoming_cwd != session.cwd,
                    incoming_output_schema != session.output_schema,
                    incoming_source_read_only != session.source_read_only,
                    incoming_system_prompt != session.system_prompt,
                    permission_mode != session.permission_mode,
                ])
                if launch_changed:
                    log(
                        "启动参数变化，重建 client 续接 thread: "
                        f"model={model or 'auto'} effort={incoming_effort or 'auto'} context={incoming_context} mode={incoming_mode} "
                        f"permission={permission_mode} schema={'on' if incoming_output_schema else 'off'} "
                        f"source_only={incoming_source_read_only}"
                    )
                    if session.client is not None:
                        await self._disconnect_client(session.client)
                        session.client = None
                    session.model = model
                    session.effort = incoming_effort
                    session.context_token_limit = incoming_context
                    session.working_mode = incoming_mode
                    session.cwd = incoming_cwd
                    session.permission_mode = permission_mode
                    session.output_schema = incoming_output_schema
                    session.source_read_only = incoming_source_read_only
                    session.system_prompt = incoming_system_prompt

                if refresh_client and session.client is not None and session.sdk_session_id:
                    old_client = session.client
                    session.client = None
                    await self._disconnect_client(old_client)
                    log(f"发送校验轮次重新连接原会话 thread={turn.thread_id}")

                legacy_plan_recovered = False
                while True:
                    client = session.client
                    if client is None:
                        client = await self._make_client(session, resume=session.sdk_session_id)
                    emit({"jsonrpc": "2.0", "method": "turn/progress", "params": {
                        "threadId": turn.thread_id, "turnId": turn.turn_id, "stage": "client_ready"}})
                    # Permission can still change within a turn, but model and
                    # context are launch parameters: reconnect the same SDK session.
                    if permission_mode != session.permission_mode:
                        try:
                            await client.set_permission_mode(permission_mode)
                            session.permission_mode = permission_mode
                        except Exception as exc:
                            log(f"set_permission_mode 失败（忽略）: {exc}")

                    if image_paths:
                        emit({"jsonrpc": "2.0", "method": "turn/progress", "params": {
                            "threadId": turn.thread_id, "turnId": turn.turn_id, "stage": "preparing_images"}})
                    client = await self._send_prompt_resilient(
                        session, client, prompt, image_paths
                    )
                    emit({"jsonrpc": "2.0", "method": "turn/progress", "params": {
                        "threadId": turn.thread_id, "turnId": turn.turn_id, "stage": "prompt_sent"}})

                    result_message = None
                    try:
                        async for message in client.receive_response():
                            if turn.cancelled:
                                break
                            emit({"jsonrpc": "2.0", "method": "turn/progress", "params": {
                                "threadId": turn.thread_id, "turnId": turn.turn_id, "stage": "response"}})
                            if isinstance(message, ErrorMessage):
                                raise WorkBuddyModelFailure(message.error or "WorkBuddy 返回未知错误")
                            if isinstance(message, ResultMessage):
                                result_message = message
                                emit({"jsonrpc": "2.0", "method": "turn/usage", "params": {
                                    "threadId": turn.thread_id, "turnId": turn.turn_id,
                                    "usage": result_usage(message)}})
                                # SDK 的真实会话 id：重建 client / 网关重启后的续接全靠它
                                sdk_id = getattr(message, "session_id", None)
                                if sdk_id and sdk_id not in session.retired_sdk_session_ids:
                                    session.sdk_session_id = sdk_id
                                    self._remember_session_id(turn.thread_id, sdk_id)
                            model_error = model_message_error(message)
                            if model_error:
                                raise WorkBuddyModelFailure(model_error)
                            if isinstance(message, AssistantMessage):
                                chunk = "".join(
                                    b.text for b in message.content if isinstance(b, TextBlock)
                                )
                                if chunk:
                                    if chunk.startswith("Empty stream: upstream gateway sent only placeholder chunks"):
                                        raise WorkBuddyModelFailure(chunk)
                                    turn.text += chunk
                                    emit({
                                        "jsonrpc": "2.0",
                                        "method": "item/agentMessage/delta",
                                        "params": {
                                            "threadId": turn.thread_id,
                                            "turnId": turn.turn_id,
                                            "delta": chunk,
                                        },
                                    })
                    except Exception as exc:
                        if (not legacy_plan_recovered
                                and self._is_legacy_plan_mode_error(exc)):
                            legacy_plan_recovered = True
                            turn.text = ""
                            await self._retire_client(session, client, exc)
                            await self._migrate_legacy_plan_session(session)
                            emit({"jsonrpc": "2.0", "method": "turn/progress", "params": {
                                "threadId": turn.thread_id,
                                "turnId": turn.turn_id,
                                "stage": "legacy_plan_migrated",
                            }})
                            continue
                        raise
                    break

                if not turn.cancelled and not turn.text.strip():
                    fallback = None
                    if result_message is not None:
                        structured = getattr(result_message, "structured_output", None)
                        if structured is not None:
                            fallback = json.dumps(structured, ensure_ascii=False)
                        else:
                            fallback = getattr(result_message, "result", None)
                    if fallback and str(fallback).strip():
                        turn.text = str(fallback)
                    elif not os.environ.get("CODEX_REMOTE_CONTACT_QQ_MCP_ENDPOINT"):
                        subtype = getattr(result_message, "subtype", None) if result_message else None
                        stop_reason = getattr(result_message, "stop_reason", None) if result_message else None
                        details = ", ".join(item for item in [subtype, stop_reason] if item)
                        raise RuntimeError(
                            "WorkBuddy 本轮没有返回任何可发送内容"
                            + (f"（{details}）" if details else "")
                        )


            if turn.cancelled:
                # 先把这一轮的收尾消息读干净再放锁：中断后 CLI 仍会补发本轮
                # 的 result/error，若留到下一轮，会被下一轮的 receive 当成
                # 「本轮已结束」直接返回，导致新轮次拿到空文本。
                await self._settle(client)
                self._release_turn(turn)
                emit({
                    "jsonrpc": "2.0",
                    "method": "turn/completed",
                    "params": {
                        "threadId": turn.thread_id,
                        "turn": {"id": turn.turn_id, "status": "interrupted", "items": []},
                    },
                })
            else:
                self._release_turn(turn)
                emit({
                    "jsonrpc": "2.0",
                    "method": "turn/completed",
                    "params": {
                        "threadId": turn.thread_id,
                        "turn": {
                            "id": turn.turn_id,
                            "status": "completed",
                            "items": [
                                {"type": "agentMessage", "text": turn.text}
                            ],
                        },
                    },
                })
        except asyncio.CancelledError:
            self._release_turn(turn)
            emit({
                "jsonrpc": "2.0",
                "method": "turn/completed",
                "params": {
                    "threadId": turn.thread_id,
                    "turn": {"id": turn.turn_id, "status": "interrupted", "items": []},
                },
            })
        except Exception as exc:
            # Never replay an accepted prompt here: it may have side effects.
            # Node owns one audited continuation inside the same queued job.
            transient = self._is_transient_upstream_failure(exc)
            retired = False
            if (isinstance(exc, WorkBuddyModelFailure) or self._is_transport_failure(exc) or transient) and session.client is not None:
                retired = await self._retire_client(session, session.client, exc)
            log(f"turn 失败: {exc}\n{traceback.format_exc()}")
            self._release_turn(turn)
            recovery = {}
            if transient and retired and session.client is None and turn.turn_id not in self.turns and self.active_by_group.get(turn.group_id) is not turn:
                recovery = {"released": True, "toolAttempts": sorted(turn.tool_attempts)}
            emit({
                "jsonrpc": "2.0",
                "method": "error",
                "params": {
                    "threadId": turn.thread_id,
                    "turnId": turn.turn_id,
                    "error": {"message": self._friendly_error(exc),
                              **({"code": "WORKBUDDY_TRANSIENT_UPSTREAM"} if recovery else {})},
                    **recovery,
                },
            })
        finally:
            self._release_turn(turn)

    def _release_turn(self, turn: Turn) -> None:
        # Release before notifying the gateway: it may start another turn as
        # soon as it receives turn/completed, before this coroutine's finally.
        self.turns.pop(turn.turn_id, None)
        if self.active_by_group.get(turn.group_id) is turn:
            self.active_by_group.pop(turn.group_id, None)
        turn.done.set()

    async def _settle(self, client: Any, timeout_s: float = 6.0) -> None:
        """中断后把本轮残留消息读干净（全部丢弃）。

        中断只会让 CLI 停止产出，它仍会补发本轮的终结消息。留着它，下一轮
        `receive_response()` 一上来就读到那条终结消息并立刻返回，新轮次就成了空文本。
        这里按「读到终结消息或超时」为止，超时也不阻塞会话恢复。
        """
        from codebuddy_agent_sdk import ResultMessage

        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        stream = client.receive_messages()
        settled = False
        try:
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                try:
                    message = await asyncio.wait_for(stream.__anext__(), timeout=remaining)
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break
                if isinstance(message, ResultMessage) or type(message).__name__ == "ErrorMessage":
                    settled = True
                    break
        except Exception as exc:  # 读残留失败不该影响会话继续可用
            log(f"settle 读取异常（忽略）: {exc}")
        finally:
            try:
                await stream.aclose()
            except Exception:
                pass
        log("中断残留已读净" if settled else "中断残留读净超时（继续）")

    async def _send_prompt(self, client: Any, prompt: str, image_paths: list) -> None:
        """发一轮提示。

        `client.query()` 第一次会顺带完成 SDK 的 initialize 控制握手；而 CLI 冷启动
        （拉插件市场 / 产品配置）期间可能接不住这条请求，表现为
        `Control request 'initialize' timed out`。SDK 每次都会生成新的 request_id、
        超时后清理干净，所以重发是安全的——只有真正接住的那一次会继续把用户消息写进去。
        """
        last_error: Optional[Exception] = None
        for attempt in range(1, INIT_RETRY_ATTEMPTS + 1):
            try:
                # 每次重试都要重新构造 payload：带图时它是异步生成器，只能被迭代一次。
                # Native image conversion must not block interrupt/control RPCs.
                payload = await asyncio.to_thread(self._prompt_payload, prompt, image_paths)
                await client.query(payload)
                if attempt > 1:
                    log(f"initialize 第 {attempt} 次接住")
                return
            except Exception as exc:
                last_error = exc
                if not self._is_control_timeout(exc):
                    raise
                log(f"initialize 第 {attempt} 次未接住（CLI 冷启动中），重发…")
                await asyncio.sleep(1.0)
        raise RuntimeError(
            f"CLI 连续 {INIT_RETRY_ATTEMPTS} 次未接住 initialize，"
            f"最后错误：{last_error}"
        )

    @staticmethod
    def _is_control_timeout(exc: Exception) -> bool:
        text = str(exc)
        return "Control request" in text and "timed out" in text

    @classmethod
    def _build_prompt(cls, prompt: str, image_paths: list) -> Any:
        """组装带图消息，并约束 Base64 请求体的总体积。

        普通图片和 QQ 原生表情都会进入主会话，确保 Agent 能结合视觉内容
        自然回复；表情收藏与用途标注仍由独立临时会话负责。这里对全部视觉
        输入统一执行总量预算：积压较多时生成临时 JPEG 预览；无法安全压缩
        的图片会明确标注为未附加，而不是让整轮请求直接失败。
        """
        if not image_paths:
            return prompt
        blocks: list = [{"type": "text", "text": prompt}]
        existing_paths = [str(path) for path in image_paths if path and os.path.isfile(str(path))]
        missing_count = len(image_paths) - len(existing_paths)
        omitted_count = max(0, len(existing_paths) - MAX_PROMPT_IMAGE_COUNT)
        if omitted_count:
            # 最新图片通常最接近本轮触发消息；极端情况下优先保留它们。
            existing_paths = existing_paths[-MAX_PROMPT_IMAGE_COUNT:]

        optimized_count = 0
        attached_count = 0
        used_bytes = 0
        deadline = time.monotonic() + MAX_IMAGE_PREPARATION_SECONDS
        with tempfile.TemporaryDirectory(prefix="codexremotecontact-agent-images-") as temp_dir:
            for index, path in enumerate(existing_paths):
                remaining_count = len(existing_paths) - index
                if time.monotonic() >= deadline:
                    omitted_count += remaining_count
                    break
                remaining_bytes = MAX_PROMPT_IMAGE_RAW_BYTES - used_bytes
                if remaining_bytes < MIN_PROMPT_IMAGE_BYTES:
                    omitted_count += remaining_count
                    break
                target_bytes = max(
                    MIN_PROMPT_IMAGE_BYTES,
                    remaining_bytes // max(1, remaining_count),
                )
                prepared = cls._prepare_prompt_image(path, target_bytes, temp_dir, index, deadline)
                if prepared is None:
                    omitted_count += 1
                    continue
                data, media_type, was_optimized = prepared
                if used_bytes + len(data) > MAX_PROMPT_IMAGE_RAW_BYTES:
                    omitted_count += 1
                    continue
                used_bytes += len(data)
                attached_count += 1
                optimized_count += int(was_optimized)
                blocks.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": base64.b64encode(data).decode("ascii"),
                    },
                })

        notes = []
        if optimized_count:
            notes.append(
                f"为避免视觉请求超出长度，网关为本轮 {optimized_count} 张图片生成了临时压缩预览；原始缓存文件未改动。"
            )
        unavailable_count = missing_count + omitted_count
        if unavailable_count:
            notes.append(
                f"另有 {unavailable_count} 张图片因不存在或仍超出安全输入预算而未附加；不要假装看到了这些图片。"
            )
        if notes:
            blocks[0]["text"] = f"{prompt}\n\n【网关视觉输入说明】{' '.join(notes)}"
        if optimized_count or unavailable_count:
            log(
                f"视觉输入预算：请求 {len(image_paths)} 张，附加 {attached_count} 张，"
                f"压缩 {optimized_count} 张，跳过 {unavailable_count} 张，原始字节 {used_bytes}"
            )
        return {"type": "user", "message": {"role": "user", "content": blocks}}

    @staticmethod
    def _prepare_prompt_image(
        path: str, target_bytes: int, temp_dir: str, index: int, deadline: Optional[float] = None
    ) -> Optional[tuple[bytes, str, bool]]:
        deadline = deadline if deadline is not None else time.monotonic() + MAX_IMAGE_PREPARATION_SECONDS
        try:
            size = os.path.getsize(path)
            media_type = mimetypes.guess_type(path)[0]
            # Small GIF/WebP files can still expand dramatically inside the SDK.
            # Only already-small, bounded-dimension JPEG/PNG bypass conversion.
            if 0 < size <= target_bytes and media_type in ("image/jpeg", "image/png") and os.path.isfile(SIPS_PATH):
                dimensions = subprocess.run([SIPS_PATH, "-g", "pixelWidth", "-g", "pixelHeight", path],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
                    timeout=max(0.1, min(5.0, deadline - time.monotonic())))
                values = re.findall(rb"pixel(?:Width|Height):\s*(\d+)", dimensions.stdout)
                if dimensions.returncode == 0 and len(values) == 2 and all(0 < int(v) <= 1280 for v in values):
                    with open(path, "rb") as fh:
                        return fh.read(), media_type, False
        except Exception as exc:
            log(f"图片读取失败，跳过 {path}: {exc}")
            return None

        if not os.path.isfile(SIPS_PATH):
            log(f"图片超过 {target_bytes} bytes 且 sips 不可用，跳过 {path}")
            return None

        for attempt, (max_dimension, quality) in enumerate(IMAGE_REDUCTION_ATTEMPTS):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            output_path = os.path.join(temp_dir, f"image-{index}-{attempt}.jpg")
            try:
                completed = subprocess.run(
                    [
                        SIPS_PATH,
                        "-Z", str(max_dimension),
                        "-s", "format", "jpeg",
                        "-s", "formatOptions", str(quality),
                        path,
                        "--out", output_path,
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    check=False,
                    timeout=min(8.0, remaining),
                )
                if completed.returncode != 0 or not os.path.isfile(output_path):
                    continue
                output_size = os.path.getsize(output_path)
                if 0 < output_size <= target_bytes:
                    with open(output_path, "rb") as fh:
                        return fh.read(), "image/jpeg", True
            except Exception as exc:
                log(f"图片临时压缩失败 {path}: {exc}")
                break
        log(f"图片无法压缩到 {target_bytes} bytes，跳过 {path}")
        return None

    @staticmethod
    async def _as_async_iter(payload: Dict[str, Any]):
        """把单个消息对象包成 AsyncIterable[dict]，供 query() 逐条拉取。"""
        yield payload

    @classmethod
    def _prompt_payload(cls, prompt: str, image_paths: list) -> Any:
        """query() 的 prompt 参数只接受 `str` 或 `AsyncIterable[dict]`。

        无图时 _build_prompt 返回 str，可以直接传；带图时返回的是**单个消息对象
        （dict）**，直接传会让 SDK 内部对它 `async for`，抛出
        `'async for' requires an object with __aiter__ method, got dict`。
        必须先包成异步迭代器。
        """
        payload = cls._build_prompt(prompt, image_paths)
        if isinstance(payload, dict):
            return cls._as_async_iter(payload)
        return payload

    @staticmethod
    def _friendly_error(exc: Exception) -> str:
        """SDK 的报错已经足够清楚，原样透传（末尾附一句人话）。"""
        text = str(exc) or exc.__class__.__name__
        if "not found" in text and "Currently supported models" in text:
            return "模型不可用：" + text.split("Currently supported models")[0].strip()
        return text

    async def turn_interrupt(self, params: Dict[str, Any]) -> Dict[str, Any]:
        turn_id = str(params.get("turnId") or "")
        thread_id = str(params.get("threadId") or "")
        turn = self.turns.get(turn_id)
        if turn is None:
            for candidate in self.turns.values():
                if candidate.thread_id == thread_id:
                    turn = candidate
                    break
        if turn is None:
            log(f"turn/interrupt 未找到进行中的轮次 thread={thread_id} turn={turn_id}")
            return {"ok": False}
        turn.cancelled = True
        log(f"turn/interrupt 命中 turn={turn.turn_id} thread={turn.thread_id}")
        session = self.sessions.get(turn.thread_id)
        if session and session.client is not None:
            try:
                await asyncio.wait_for(
                    session.client.interrupt(),
                    timeout=self.interrupt_grace_seconds,
                )
            except asyncio.TimeoutError:
                log(f"interrupt 超时，准备强制回收 turn={turn.turn_id}")
            except Exception as exc:
                log(f"interrupt 失败: {exc}")
        try:
            await asyncio.wait_for(
                turn.done.wait(),
                timeout=self.interrupt_grace_seconds,
            )
            return {"ok": True, "forced": False, "toolAttempts": sorted(turn.tool_attempts)}
        except asyncio.TimeoutError:
            log(f"turn 中断后未正常结束，强制回收 turn={turn.turn_id} group={turn.group_id}")
            await self._force_cancel_turn(turn, session)
            return {"ok": True, "forced": True, "toolAttempts": sorted(turn.tool_attempts)}

    async def _force_cancel_turn(
        self,
        turn: Turn,
        session: Optional[Session],
    ) -> None:
        """Cancel a stuck turn and retire its CLI before the target is reused."""
        client = session.client if session is not None else None
        if session is not None and client is not None and session.client is client:
            # A replacement turn must never inherit the half-interrupted stream.
            session.client = None
            session.closed = False

        task = turn.task
        if task is not None and not task.done():
            task.cancel()
            await asyncio.wait({task}, timeout=self.force_cancel_wait_seconds)

        if client is not None:
            try:
                await self._disconnect_client(client)
            except Exception as exc:
                log(f"强制回收中关闭旧 client 失败（继续释放目标锁）: {exc}")

        # Idempotent and identity-checked: a delayed old coroutine cannot remove
        # a newer turn that already acquired the same group id.
        self._release_turn(turn)

    # ---------------- 列表 ----------------

    async def model_list(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """按 codex app-server 的 model/list 形状返回。

        网关的 refreshCodexModels 会把「没有 supportedReasoningEfforts」的条目全部丢掉，
        所以这里必须带上档位，否则模型目录会退化成 Codex 的兜底名单。

        网关是在启动后立刻拉一次目录的，此时账号探测（要跑一次 CLI 往返）可能还没回来，
        所以这里有限度地等它一下，避免目录短暂显示成兜底名单。
        """
        if self.probe_task is not None and not self.probe_task.done():
            try:
                # shield：等超时也不能把探测任务本身取消掉
                await asyncio.wait_for(asyncio.shield(self.probe_task), timeout=MODEL_PROBE_WAIT_S)
            except Exception:
                log("账号探测未在等待窗口内返回，先用兜底名单")
        data = []
        for index, model_id in enumerate(self.models):
            data.append({
                "id": model_id,
                "model": model_id,
                "displayName": model_id,
                "description": "WorkBuddy 当前账号实时可用模型；CLI 未公开逐模型思考档位矩阵",
                "hidden": False,
                "isDefault": model_id == "auto"
                or (index == 0 and "auto" not in self.models),
                "defaultReasoningEffort": DEFAULT_EFFORT,
                "supportedReasoningEfforts": [
                    {"reasoningEffort": "auto", "description": "不固定档位，由当前模型决定"},
                    *[
                        {"reasoningEffort": effort, "description": "WorkBuddy CLI 公开档位；模型不支持时可能自动忽略"}
                        for effort in EFFORTS
                    ],
                ],
                "reasoningCapabilitySource": "workbuddy-cli-global",
            })
        return {"data": data, "nextCursor": None}

    async def thread_loaded_list(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"data": list(self.sessions.keys()), "nextCursor": None}

    async def shutdown(self, params: Dict[str, Any]) -> Dict[str, Any]:
        for turn in list(self.turns.values()):
            turn.cancelled = True
            if turn.task:
                turn.task.cancel()
        for session in self.sessions.values():
            if session.client is not None:
                await self._disconnect_client(session.client)
            session.closed = True
        self.sessions.clear()
        return {"ok": True}

    # ---------------- 分发 ----------------

    async def dispatch(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        table = {
            "initialize": self.initialize,
            "thread/start": self.thread_start,
            "thread/resume": self.thread_resume,
            "thread/delete": self.thread_delete,
            "turn/start": self.turn_start,
            "turn/interrupt": self.turn_interrupt,
            "model/list": self.model_list,
            "thread/loaded/list": self.thread_loaded_list,
            "shutdown": self.shutdown,
        }
        handler = table.get(method)
        if handler is None:
            raise RuntimeError(f"未知方法: {method}")
        return await handler(params)


async def serve() -> None:
    bridge = Bridge()
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    tasks = set()
    while True:
        line = await reader.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            continue
        try:
            message = json.loads(text)
        except Exception:
            log(f"无法解析的输入行: {text[:200]}")
            continue

        request_id = message.get("id")
        method = str(message.get("method") or "")
        params = message.get("params") or {}

        async def run(req_id=request_id, m=method, p=params) -> None:
            try:
                result = await bridge.dispatch(m, p)
                if req_id is not None:
                    emit({"jsonrpc": "2.0", "id": req_id, "result": result})
            except Exception as exc:
                log(f"{m} 失败: {exc}")
                if req_id is not None:
                    emit({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"message": str(exc)},
                    })

        # 并发处理；turn/start 自身立刻返回，轮次在后台任务里跑
        task = asyncio.create_task(run())
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    await bridge.shutdown({})


if __name__ == "__main__":
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass
