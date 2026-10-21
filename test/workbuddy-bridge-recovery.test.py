#!/usr/bin/env python3
"""Focused regression tests for the long-lived WorkBuddy bridge transport."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch


BRIDGE_PATH = (
    pathlib.Path(__file__).resolve().parents[1]
    / "modules"
    / "workbuddy-agent"
    / "bridge.py"
)
SPEC = importlib.util.spec_from_file_location("workbuddy_bridge_under_test", BRIDGE_PATH)
assert SPEC is not None and SPEC.loader is not None
BRIDGE_MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BRIDGE_MODULE
SPEC.loader.exec_module(BRIDGE_MODULE)


class FakeClient:
    def __init__(self) -> None:
        self.disconnected = False
        self.interrupted = False

    async def disconnect(self) -> None:
        self.disconnected = True

    async def interrupt(self) -> None:
        self.interrupted = True


class BridgeRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def test_usage_keeps_sdk_fields_raw_and_missing_cache_unknown(self) -> None:
        from types import SimpleNamespace
        result = SimpleNamespace(usage={"input_tokens": 7, "output_tokens": 3}, num_turns=2)
        self.assertEqual(BRIDGE_MODULE.result_usage(result), {
            "inputTokens": 7, "outputTokens": 3, "cachedTokens": None,
            "cacheCreationTokens": None, "modelCalls": 2,
        })
        result.usage = SimpleNamespace(input_tokens=0, output_tokens=3, cache_read_input_tokens=90,
                                       cache_creation_input_tokens=5)
        usage = BRIDGE_MODULE.result_usage(result)
        self.assertEqual(usage["inputTokens"], 0)
        self.assertEqual(usage["cachedTokens"], 90)
        result.usage = {"input_tokens": True, "output_tokens": -1}
        self.assertIsNone(BRIDGE_MODULE.result_usage(result)["inputTokens"])
        self.assertIsNone(BRIDGE_MODULE.result_usage(result)["outputTokens"])

    def test_model_errors_are_not_successful_empty_turns(self) -> None:
        from codebuddy_agent_sdk import AssistantMessage, ResultMessage
        error = ResultMessage(subtype="error_during_execution", duration_ms=0, duration_api_ms=0,
            is_error=True, num_turns=1, session_id="test", errors=["Empty stream from upstream"])
        self.assertEqual(BRIDGE_MODULE.model_message_error(error), "Empty stream from upstream")
        self.assertEqual(BRIDGE_MODULE.model_message_error(AssistantMessage(content=[], model="test", error="empty_stream")), "empty_stream")
        success = ResultMessage(subtype="success", duration_ms=0, duration_api_ms=0,
            is_error=False, num_turns=1, session_id="test", result="")
        self.assertIsNone(BRIDGE_MODULE.model_message_error(success))

    async def test_terminal_empty_stream_retires_client_without_replaying_or_completing(self) -> None:
        from codebuddy_agent_sdk import ResultMessage
        bridge = BRIDGE_MODULE.Bridge()
        session = BRIDGE_MODULE.Session("model-failure-thread", "/tmp")
        client = FakeClient()
        session.client = client
        bridge.sessions[session.thread_id] = session
        turn = BRIDGE_MODULE.Turn(session.thread_id, "model-failure-turn", "model-failure-group")
        bridge.turns[turn.turn_id] = turn
        bridge.active_by_group[turn.group_id] = turn
        async def responses():
            yield ResultMessage(subtype="error_during_execution", duration_ms=0, duration_api_ms=0,
                is_error=True, num_turns=1, session_id="original-session", result="Empty stream from upstream")
        client.receive_response = responses
        bridge._send_prompt_resilient = AsyncMock(return_value=client)
        bridge._remember_session_id = lambda *_args: None
        events = []
        with patch.object(BRIDGE_MODULE, "emit", side_effect=events.append):
            await bridge._run_turn(turn, session, {"prompt": "test", "cwd": "/tmp", "turnSandbox": {"type": "readOnly"}})
        self.assertTrue(client.disconnected)
        self.assertIsNone(session.client)
        self.assertEqual(session.sdk_session_id, "original-session")
        self.assertNotIn(turn.turn_id, bridge.turns)
        self.assertEqual(bridge._send_prompt_resilient.await_count, 1)
        self.assertTrue(any(e.get("method") == "error" for e in events))
        self.assertFalse(any(e.get("method") == "turn/completed" for e in events))

    def test_system_prompt_is_bounded_and_sanitized(self) -> None:
        value = "  老代\x00人格  " + ("很" * 13_000)

        prompt = BRIDGE_MODULE.normalize_system_prompt(value)

        self.assertNotIn("\x00", prompt)
        self.assertTrue(prompt.startswith("老代人格"))
        self.assertEqual(len(prompt), 12_000)

    def test_auto_output_schema_is_validated_by_gateway_not_cli(self) -> None:
        session = BRIDGE_MODULE.Session("thread-auto", "/tmp")
        session.context_token_limit = "200000"
        session.output_schema = json.dumps({"type": "object"})

        args = BRIDGE_MODULE.session_extra_args(session)

        self.assertEqual(args["autocompact"], "200000")
        self.assertNotIn("json-schema", args)

    async def test_qq_catalog_stays_inline_without_widening_source_permissions(self) -> None:
        bridge = BRIDGE_MODULE.Bridge()
        normal = BRIDGE_MODULE.Session("thread-chat", "/tmp")
        normal.effort = "low"
        source = BRIDGE_MODULE.Session("thread-source", "/tmp")
        source.source_read_only = True
        source.effort = "low"
        source.permission_mode = "default"
        clients = [FakeClient(), FakeClient()]
        for client in clients:
            client.connect = AsyncMock()
        with patch.dict(os.environ, {
            "CODEX_REMOTE_CONTACT_QQ_MCP_ENDPOINT": "http://127.0.0.1:12345/call",
            "CODEX_REMOTE_CONTACT_QQ_MCP_SECRET": "test-secret",
        }), patch("codebuddy_agent_sdk.CodeBuddySDKClient", side_effect=clients) as factory:
            await bridge._make_client(normal)
            await bridge._make_client(source)

        normal_options = factory.call_args_list[0].kwargs["options"]
        normal_server = normal_options.mcp_servers["qq_gateway"]
        self.assertEqual(normal_options.effort, "low")
        self.assertEqual(normal_options.permission_mode, "dontAsk")
        self.assertEqual(normal_options.tools, BRIDGE_MODULE.READ_ONLY_TOOLS)
        self.assertEqual(normal_options.disallowed_tools, [])
        self.assertFalse(normal_server["defer_loading"])
        self.assertEqual(normal_server["tools"], {})
        source_options = factory.call_args_list[1].kwargs["options"]
        self.assertEqual(source_options.tools, [])
        self.assertEqual(source_options.disallowed_tools, [])
        self.assertEqual(source_options.permission_mode, "default")
        source_server = source_options.mcp_servers["qq_gateway"]
        self.assertFalse(source_server["defer_loading"])
        self.assertEqual(source_server["env"]["CODEX_REMOTE_CONTACT_QQ_MCP_SOURCE_ONLY"], "1")
        self.assertEqual(source_server["tools"], {})

    async def test_full_and_ephemeral_sessions_preserve_their_existing_tool_scope(self) -> None:
        bridge = BRIDGE_MODULE.Bridge()
        for ephemeral in (False, True):
            with self.subTest(ephemeral=ephemeral):
                session = BRIDGE_MODULE.Session(f"thread-full-{ephemeral}", "/tmp")
                session.permission_mode = "bypassPermissions"
                session.ephemeral = ephemeral
                fake = FakeClient()
                fake.connect = AsyncMock()
                with patch.dict(os.environ, {
                    "CODEX_REMOTE_CONTACT_QQ_MCP_ENDPOINT": "http://127.0.0.1:12345/call",
                    "CODEX_REMOTE_CONTACT_QQ_MCP_SECRET": "test-secret",
                }), patch("codebuddy_agent_sdk.CodeBuddySDKClient", return_value=fake) as factory:
                    await bridge._make_client(session)
                options = factory.call_args.kwargs["options"]
                self.assertIsNone(options.tools)
                self.assertEqual(options.permission_mode, "bypassPermissions")
                self.assertEqual(bool(options.mcp_servers), not ephemeral)

    async def test_compaction_hooks_report_both_phases_without_changing_the_thread(self) -> None:
        bridge = BRIDGE_MODULE.Bridge()
        session = BRIDGE_MODULE.Session("thread-compaction", "/tmp")
        fake = FakeClient()
        fake.connect = AsyncMock()
        with patch("codebuddy_agent_sdk.CodeBuddySDKClient", return_value=fake) as factory:
            await bridge._make_client(session)
        hooks = factory.call_args.kwargs["options"].hooks
        events = []
        with patch.object(BRIDGE_MODULE, "emit", side_effect=events.append):
            await hooks["PreCompact"][0].hooks[0]({"trigger": "auto"}, None, {})
            await hooks["PostCompact"][0].hooks[0]({"trigger": "auto"}, None, {})
        self.assertEqual([event["method"] for event in events], ["thread/compacting", "thread/compacted"])
        self.assertTrue(all(event["params"]["threadId"] == session.thread_id for event in events))

    async def test_resume_defers_parameter_changes_while_turn_is_active(self) -> None:
        bridge = BRIDGE_MODULE.Bridge()
        session = BRIDGE_MODULE.Session("thread-active-switch", "/tmp")
        session.model = "hy3"
        session.context_token_limit = "100000"
        client = FakeClient()
        session.client = client
        bridge.sessions[session.thread_id] = session
        turn = BRIDGE_MODULE.Turn(session.thread_id, "turn-active-switch", "group-active-switch")
        bridge.turns[turn.turn_id] = turn
        bridge.active_by_group[turn.group_id] = turn
        params = {"threadId": session.thread_id, "cwd": "/tmp", "model": "glm-5.3-flash",
                  "contextTokenLimit": "100000", "workingMode": "agent"}

        deferred = await bridge.thread_resume(params)
        self.assertTrue(deferred["deferred"])
        self.assertEqual(session.model, "hy3")
        self.assertIs(session.client, client)
        self.assertFalse(client.disconnected)

        bridge._release_turn(turn)
        resumed = await bridge.thread_resume(params)
        self.assertNotIn("deferred", resumed)
        self.assertEqual(session.model, "glm-5.3-flash")
        self.assertIsNone(session.client)
        self.assertTrue(client.disconnected)

    async def test_headless_gateway_is_always_agent_and_never_advertises_plan_transitions(self) -> None:
        from codebuddy_agent_sdk import PermissionResultDeny
        bridge = BRIDGE_MODULE.Bridge()
        session = BRIDGE_MODULE.Session("thread-agent-only", "/tmp")
        session.permission_mode = "acceptEdits"
        fake = FakeClient()
        fake.connect = AsyncMock()
        with patch("codebuddy_agent_sdk.CodeBuddySDKClient", return_value=fake) as factory:
            await bridge._make_client(session)
        options = factory.call_args.kwargs["options"]
        self.assertEqual(options.disallowed_tools, [])
        self.assertIsInstance(await options.can_use_tool("ExitPlanMode", {}, None), PermissionResultDeny)
        self.assertNotIn("permission-mode-before-plan", BRIDGE_MODULE.session_extra_args(session))
        self.assertEqual(BRIDGE_MODULE.normalize_working_mode("plan"), "agent")
        self.assertEqual(BRIDGE_MODULE.normalize_working_mode("ask"), "agent")
        self.assertEqual(BRIDGE_MODULE.SANDBOX_TO_PERMISSION["readOnly"], "dontAsk")

    async def test_legacy_plan_transcript_is_forked_and_repaired_without_qq_tools(self) -> None:
        from codebuddy_agent_sdk import PermissionResultAllow, PermissionResultDeny, ResultMessage
        bridge = BRIDGE_MODULE.Bridge()
        session = BRIDGE_MODULE.Session("thread-legacy-plan", "/tmp")
        session.sdk_session_id = "sdk-plan-old"
        session.permission_mode = "dontAsk"
        fake = FakeClient()
        fake.connect = AsyncMock()
        fake.query = AsyncMock()

        async def responses():
            yield ResultMessage(subtype="success", duration_ms=0, duration_api_ms=0,
                is_error=False, num_turns=1, session_id="sdk-agent-new", result="")

        fake.receive_response = responses
        with patch("codebuddy_agent_sdk.CodeBuddySDKClient", return_value=fake) as factory, \
                patch.object(bridge, "_remember_session_id") as remember:
            await bridge._migrate_legacy_plan_session(session)

        options = factory.call_args.kwargs["options"]
        self.assertTrue(options.fork_session)
        self.assertEqual(options.resume, "sdk-plan-old")
        self.assertEqual(options.permission_mode, "default")
        self.assertEqual(options.tools, ["ExitPlanMode"])
        self.assertEqual(options.mcp_servers, {})
        self.assertEqual(options.extra_args["permission-mode-before-plan"], "dontAsk")
        self.assertIsInstance(await options.can_use_tool("ExitPlanMode", {}, None), PermissionResultAllow)
        self.assertIsInstance(await options.can_use_tool("Bash", {}, None), PermissionResultDeny)
        self.assertEqual(session.sdk_session_id, "sdk-agent-new")
        self.assertEqual(session.retired_sdk_session_ids, {"sdk-plan-old"})
        self.assertIsNone(session.client)
        remember.assert_called_once_with("thread-legacy-plan", "sdk-agent-new")
        self.assertTrue(fake.disconnected)

    def test_only_exact_missing_exit_plan_errors_trigger_legacy_migration(self) -> None:
        self.assertTrue(BRIDGE_MODULE.Bridge._is_legacy_plan_mode_error(
            RuntimeError("Tool ExitPlanMode not found in agent cli.")))
        self.assertTrue(BRIDGE_MODULE.Bridge._is_legacy_plan_mode_error(
            RuntimeError('Tool "ExitPlanMode" does not exist in the current tool set.')))
        self.assertFalse(BRIDGE_MODULE.Bridge._is_legacy_plan_mode_error(
            RuntimeError("ExitPlanMode permission denied")))

    async def test_release_before_completion_does_not_remove_the_next_turn(self) -> None:
        bridge = BRIDGE_MODULE.Bridge()
        first = BRIDGE_MODULE.Turn("thread-1", "turn-1", "group-1")
        bridge.turns[first.turn_id] = first
        bridge.active_by_group[first.group_id] = first

        bridge._release_turn(first)
        self.assertNotIn(first.turn_id, bridge.turns)
        self.assertNotIn(first.group_id, bridge.active_by_group)
        self.assertTrue(first.done.is_set())

        second = BRIDGE_MODULE.Turn("thread-1", "turn-2", "group-1")
        bridge.turns[second.turn_id] = second
        bridge.active_by_group[second.group_id] = second
        bridge._release_turn(first)  # old coroutine's finally runs after the next turn starts
        self.assertIs(bridge.active_by_group[second.group_id], second)

    async def test_stuck_interrupted_turn_is_force_released_and_client_retired(self) -> None:
        bridge = BRIDGE_MODULE.Bridge()
        bridge.interrupt_grace_seconds = 0.01
        bridge.force_cancel_wait_seconds = 0.05
        session = BRIDGE_MODULE.Session("thread-stuck", "/tmp")
        session.sdk_session_id = "sdk-session-stuck"
        client = FakeClient()
        session.client = client
        bridge.sessions[session.thread_id] = session
        turn = BRIDGE_MODULE.Turn(session.thread_id, "turn-stuck", "group-stuck")
        turn.task = asyncio.create_task(asyncio.Event().wait())
        bridge.turns[turn.turn_id] = turn
        bridge.active_by_group[turn.group_id] = turn

        result = await bridge.turn_interrupt({
            "threadId": session.thread_id,
            "turnId": turn.turn_id,
        })

        self.assertTrue(result["ok"])
        self.assertTrue(result["forced"])
        self.assertTrue(client.interrupted)
        self.assertTrue(client.disconnected)
        self.assertIsNone(session.client)
        self.assertEqual(session.sdk_session_id, "sdk-session-stuck")
        self.assertNotIn(turn.turn_id, bridge.turns)
        self.assertNotIn(turn.group_id, bridge.active_by_group)
        self.assertTrue(turn.done.is_set())
        self.assertTrue(turn.task.done())

    async def test_send_recovery_refreshes_cli_but_resumes_the_same_session(self) -> None:
        bridge = BRIDGE_MODULE.Bridge()
        session = BRIDGE_MODULE.Session("thread-recovery", "/tmp")
        session.sdk_session_id = "sdk-session-recovery"
        original = FakeClient()
        session.client = original
        bridge.sessions[session.thread_id] = session
        turn = BRIDGE_MODULE.Turn(session.thread_id, "turn-recovery", "group-recovery")
        bridge.turns[turn.turn_id] = turn
        bridge.active_by_group[turn.group_id] = turn
        replacement = FakeClient()
        async def responses():
            from codebuddy_agent_sdk import ResultMessage
            yield ResultMessage(subtype="success", duration_ms=0, duration_api_ms=0,
                is_error=False, num_turns=1, session_id="sdk-session-recovery", result="已完成")
        replacement.receive_response = responses
        async def make_client(target_session, resume=None):
            self.assertIs(target_session, session)
            self.assertEqual(resume, "sdk-session-recovery")
            target_session.client = replacement
            return replacement
        bridge._make_client = AsyncMock(side_effect=make_client)
        bridge._send_prompt_resilient = AsyncMock(return_value=replacement)
        bridge._remember_session_id = lambda *_args: None
        events = []
        with patch.object(BRIDGE_MODULE, "emit", side_effect=events.append):
            await bridge._run_turn(turn, session, {"prompt": "校验", "cwd": "/tmp",
                "turnSandbox": {"type": "readOnly"}, "refreshClientBeforeTurn": True})
        self.assertTrue(original.disconnected)
        self.assertIs(session.client, replacement)
        self.assertTrue(any(event.get("method") == "turn/completed" for event in events))

    async def test_model_change_reconnects_the_same_session_without_hot_set_model(self) -> None:
        from codebuddy_agent_sdk import ResultMessage
        bridge = BRIDGE_MODULE.Bridge()
        session = BRIDGE_MODULE.Session("thread-model-change", "/tmp")
        session.model = "hy3"
        session.sdk_session_id = "sdk-session-model-change"
        original = FakeClient()
        session.client = original
        bridge.sessions[session.thread_id] = session
        replacement = FakeClient()
        replacement.set_model = AsyncMock()
        async def responses():
            yield ResultMessage(subtype="success", duration_ms=0, duration_api_ms=0,
                is_error=False, num_turns=1, session_id=session.sdk_session_id, result="已完成")
        replacement.receive_response = responses
        async def make_client(target_session, resume=None):
            self.assertIs(target_session, session)
            self.assertEqual(resume, "sdk-session-model-change")
            self.assertEqual(target_session.model, "glm-5.3-flash")
            target_session.client = replacement
            return replacement
        bridge._make_client = AsyncMock(side_effect=make_client)
        bridge._send_prompt_resilient = AsyncMock(return_value=replacement)
        bridge._remember_session_id = lambda *_args: None
        turn = BRIDGE_MODULE.Turn(session.thread_id, "turn-model-change", "group-model-change")
        bridge.turns[turn.turn_id] = turn
        bridge.active_by_group[turn.group_id] = turn
        events = []
        with patch.object(BRIDGE_MODULE, "emit", side_effect=events.append):
            await bridge._run_turn(turn, session, {"prompt": "hello", "cwd": "/tmp",
                "model": "glm-5.3-flash", "turnSandbox": {"type": "readOnly"}})
        self.assertTrue(original.disconnected)
        self.assertIs(session.client, replacement)
        replacement.set_model.assert_not_awaited()
        self.assertTrue(any(event.get("method") == "turn/progress" for event in events))
        self.assertTrue(any(event.get("method") == "turn/completed" for event in events))

    def test_transport_failure_detection_walks_exception_chain(self) -> None:
        bridge = BRIDGE_MODULE.Bridge()
        wrapped = RuntimeError("outer")
        wrapped.__cause__ = ConnectionResetError("connection reset by peer")

        self.assertTrue(bridge._is_transport_failure(wrapped))
        self.assertTrue(bridge._is_transport_failure(RuntimeError("Connection closed")))
        self.assertTrue(bridge._is_transport_failure(RuntimeError("Socket is closed (target: upstream)")))
        self.assertFalse(bridge._is_transport_failure(RuntimeError("model rejected request")))

    def test_transient_upstream_detection_rejects_auth_rate_limits_and_unknown_errors(self) -> None:
        from codebuddy_agent_sdk._errors import AuthenticationError, ExecutionError
        bridge = BRIDGE_MODULE.Bridge()
        for message in ["API Error: 502 Bad Gateway", "HTTP 503 Service Unavailable",
                        "upstream status=504", "Socket is closed", "connection reset by peer"]:
            with self.subTest(message=message):
                self.assertTrue(bridge._is_transient_upstream_failure(
                    ExecutionError([message], "error_during_execution")))
        for message in ["API Error: 401 Socket is closed", "HTTP 403 Forbidden", "status=429 rate limit",
                        "HTTP 400 invalid parameter", "HTTP 500 unknown failure", "model rejected request",
                        "invalid parameter: context_token_limit=502"]:
            with self.subTest(message=message):
                self.assertFalse(bridge._is_transient_upstream_failure(
                    ExecutionError([message], "error_during_execution")))
        wrapped = RuntimeError("outer")
        wrapped.__cause__ = AuthenticationError("unauthorized", "Socket is closed")
        self.assertFalse(bridge._is_transient_upstream_failure(wrapped))

    async def _run_sdk_error_turn(self, message, *, tools=(), shutdown_error=False):
        from codebuddy_agent_sdk import CodeBuddySDKClient, ResultMessage
        bridge = BRIDGE_MODULE.Bridge()
        session = BRIDGE_MODULE.Session("transport-thread", "/tmp")
        session.sdk_session_id = "persistent-sdk-session"
        client = FakeClient()
        if shutdown_error:
            client.disconnect = AsyncMock(side_effect=RuntimeError("cannot confirm shutdown"))
        session.client = client
        bridge.sessions[session.thread_id] = session
        turn = BRIDGE_MODULE.Turn(session.thread_id, "transport-turn", "transport-group")
        turn.tool_attempts.update(tools)
        bridge.turns[turn.turn_id] = turn
        bridge.active_by_group[turn.group_id] = turn

        async def messages():
            yield ResultMessage(subtype="error_during_execution", duration_ms=0, duration_api_ms=0,
                is_error=True, num_turns=1, session_id="must-not-replace-session", errors=[message])

        # Exercise the real SDK method: it raises ExecutionError before yielding
        # its ResultMessage, unlike a mocked bridge-level WorkBuddyModelFailure.
        client.receive_messages = messages
        client.receive_response = lambda: CodeBuddySDKClient.receive_response(client)
        bridge._send_prompt_resilient = AsyncMock(return_value=client)
        events = []

        def capture(event):
            if event.get("method") == "error":
                self.assertNotIn(turn.turn_id, bridge.turns)
                self.assertNotIn(turn.group_id, bridge.active_by_group)
                self.assertTrue(turn.done.is_set())
            events.append(event)

        with patch.object(BRIDGE_MODULE, "emit", side_effect=capture):
            await bridge._run_turn(turn, session, {"prompt": "offline", "cwd": "/tmp",
                "turnSandbox": {"type": "readOnly"}})
        bridge._send_prompt_resilient.assert_awaited_once()
        self.assertEqual(session.sdk_session_id, "persistent-sdk-session")
        self.assertFalse(any(event.get("method") == "turn/completed" for event in events))
        error = next(event["params"] for event in events if event.get("method") == "error")
        return session, client, error

    async def test_real_sdk_execution_error_retires_client_and_reports_complete_tool_audit(self) -> None:
        for message in ["API Error: 502 Socket is closed (target: https://example.invalid)",
                        "HTTP 503 Service Unavailable"]:
            for tools in [("mcp__qq_gateway__read_messages",),
                          ("Bash", "mcp__qq_gateway__send_message", "Read")]:
                with self.subTest(message=message, tools=tools):
                    session, client, error = await self._run_sdk_error_turn(message, tools=tools)
                    self.assertTrue(client.disconnected)
                    self.assertIsNone(session.client)
                    self.assertEqual(error["error"]["code"], "WORKBUDDY_TRANSIENT_UPSTREAM")
                    self.assertTrue(error["released"])
                    # Unsafe attempts remain visible; only Node decides replay safety.
                    self.assertEqual(error["toolAttempts"], sorted(tools))

    async def test_unknown_and_auth_sdk_errors_offer_no_automatic_recovery(self) -> None:
        for message in ["unknown execution failure", "API Error: 401 unauthorized", "HTTP 429 rate limit"]:
            with self.subTest(message=message):
                session, client, error = await self._run_sdk_error_turn(message)
                self.assertIs(session.client, client)
                self.assertFalse(client.disconnected)
                self.assertNotIn("code", error["error"])
                self.assertNotIn("released", error)
                self.assertNotIn("toolAttempts", error)

    async def test_failed_shutdown_does_not_offer_recovery_even_after_cache_is_cleared(self) -> None:
        session, _, error = await self._run_sdk_error_turn("Socket is closed", shutdown_error=True)
        self.assertIsNone(session.client)
        self.assertNotIn("code", error["error"])
        self.assertNotIn("released", error)
        self.assertNotIn("toolAttempts", error)

    async def test_process_kill_requires_confirmed_exit_before_recovery(self) -> None:
        from types import SimpleNamespace
        from unittest.mock import Mock
        bridge = BRIDGE_MODULE.Bridge()
        for confirmed in (True, False):
            with self.subTest(confirmed=confirmed):
                process = SimpleNamespace(returncode=None, terminate=Mock(), kill=Mock(),
                    wait=AsyncMock(side_effect=[TimeoutError(), 0 if confirmed else RuntimeError("still running")]))
                client = FakeClient()
                client.disconnect = AsyncMock(side_effect=RuntimeError("disconnect failed"))
                client._transport = SimpleNamespace(_process=process)
                self.assertEqual(await bridge._disconnect_client(client), confirmed)
                process.terminate.assert_called_once()
                process.kill.assert_called_once()

    async def test_query_failure_does_not_reconnect_until_old_client_shutdown_is_confirmed(self) -> None:
        bridge = BRIDGE_MODULE.Bridge()
        session = BRIDGE_MODULE.Session("thread-unconfirmed", "/tmp")
        client = FakeClient()
        client.disconnect = AsyncMock(side_effect=RuntimeError("cannot confirm shutdown"))
        session.client = client
        bridge._send_prompt = AsyncMock(side_effect=ConnectionResetError("socket is closed"))
        bridge._make_client = AsyncMock()
        with self.assertRaises(ConnectionResetError):
            await bridge._send_prompt_resilient(session, client, "hello", [])
        self.assertIsNone(session.client)
        bridge._make_client.assert_not_awaited()
        self.assertEqual(bridge._send_prompt.await_count, 1)

    async def test_dead_client_is_replaced_and_prompt_is_retried_once(self) -> None:
        bridge = BRIDGE_MODULE.Bridge()
        session = BRIDGE_MODULE.Session("thread-1", "/tmp")
        session.sdk_session_id = "sdk-session-1"
        original = FakeClient()
        replacement = FakeClient()
        session.client = original
        bridge._send_prompt = AsyncMock(
            side_effect=[ConnectionResetError("connection closed"), None]
        )

        async def make_client(target_session, resume=None):
            self.assertIs(target_session, session)
            self.assertEqual(resume, "sdk-session-1")
            target_session.client = replacement
            return replacement

        bridge._make_client = AsyncMock(side_effect=make_client)

        result = await bridge._send_prompt_resilient(session, original, "hello", [])

        self.assertIs(result, replacement)
        self.assertIs(session.client, replacement)
        self.assertTrue(original.disconnected)
        self.assertFalse(replacement.disconnected)
        self.assertEqual(bridge._send_prompt.await_count, 2)
        bridge._make_client.assert_awaited_once_with(session, resume="sdk-session-1")

    async def test_failed_replacement_is_not_left_cached(self) -> None:
        bridge = BRIDGE_MODULE.Bridge()
        session = BRIDGE_MODULE.Session("thread-2", "/tmp")
        session.sdk_session_id = "sdk-session-2"
        original = FakeClient()
        replacement = FakeClient()
        session.client = original
        bridge._send_prompt = AsyncMock(
            side_effect=[
                ConnectionResetError("connection closed"),
                BrokenPipeError("broken pipe"),
            ]
        )

        async def make_client(target_session, resume=None):
            target_session.client = replacement
            return replacement

        bridge._make_client = AsyncMock(side_effect=make_client)

        with self.assertRaises(BrokenPipeError):
            await bridge._send_prompt_resilient(session, original, "hello", [])

        self.assertIsNone(session.client)
        self.assertTrue(original.disconnected)
        self.assertTrue(replacement.disconnected)

    async def test_ephemeral_thread_delete_removes_history_assets_and_mapping(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            previous_home = os.environ.get("HOME")
            previous_map = BRIDGE_MODULE.SESSION_MAP_PATH
            os.environ["HOME"] = temporary
            BRIDGE_MODULE.SESSION_MAP_PATH = os.path.join(temporary, "session-map.json")
            try:
                workspace = os.path.join(temporary, "label-job")
                os.makedirs(workspace)
                bridge = BRIDGE_MODULE.Bridge()
                session = BRIDGE_MODULE.Session("thread-ephemeral", workspace)
                session.ephemeral = True
                session.sdk_session_id = "sdk-session-ephemeral"
                session.client = FakeClient()
                bridge.sessions[session.thread_id] = session
                bridge._session_map[session.thread_id] = session.sdk_session_id
                bridge._save_session_map()

                project_store = bridge._project_store_dir(workspace)
                os.makedirs(os.path.join(project_store, session.sdk_session_id))
                transcript = os.path.join(project_store, f"{session.sdk_session_id}.jsonl")
                pathlib.Path(transcript).write_text("history", encoding="utf-8")
                pathlib.Path(project_store, session.sdk_session_id, "image.png").write_bytes(b"image")

                result = await bridge.thread_delete({
                    "threadId": session.thread_id,
                    "purgeProject": True,
                })

                self.assertTrue(result["deleted"])
                self.assertTrue(result["projectStoreRemoved"])
                self.assertNotIn(session.thread_id, bridge.sessions)
                self.assertFalse(os.path.exists(project_store))
                saved_map = json.loads(pathlib.Path(BRIDGE_MODULE.SESSION_MAP_PATH).read_text(encoding="utf-8"))
                self.assertNotIn(session.thread_id, saved_map)
            finally:
                BRIDGE_MODULE.SESSION_MAP_PATH = previous_map
                if previous_home is None:
                    os.environ.pop("HOME", None)
                else:
                    os.environ["HOME"] = previous_home

    async def test_persistent_thread_cannot_be_deleted(self) -> None:
        bridge = BRIDGE_MODULE.Bridge()
        session = BRIDGE_MODULE.Session("thread-persistent", "/tmp")
        bridge.sessions[session.thread_id] = session

        with self.assertRaisesRegex(RuntimeError, "缺少网关明确授权"):
            await bridge.thread_delete({"threadId": session.thread_id, "purgeProject": True})

        self.assertIn(session.thread_id, bridge.sessions)

    async def test_explicit_persistent_cleanup_removes_only_the_exact_session(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            previous_home = os.environ.get("HOME")
            previous_map = BRIDGE_MODULE.SESSION_MAP_PATH
            os.environ["HOME"] = temporary
            BRIDGE_MODULE.SESSION_MAP_PATH = os.path.join(temporary, "session-map.json")
            try:
                workspace = os.path.join(temporary, "group-workspace")
                os.makedirs(workspace)
                bridge = BRIDGE_MODULE.Bridge()
                session = BRIDGE_MODULE.Session("thread-old", workspace)
                session.sdk_session_id = "sdk-session-old"
                bridge.sessions[session.thread_id] = session
                bridge._session_map[session.thread_id] = session.sdk_session_id
                bridge._save_session_map()
                project_store = bridge._project_store_dir(workspace)
                os.makedirs(project_store)
                transcript = pathlib.Path(project_store, f"{session.sdk_session_id}.jsonl")
                unrelated = pathlib.Path(project_store, "unrelated.jsonl")
                transcript.write_text("old history", encoding="utf-8")
                unrelated.write_text("keep", encoding="utf-8")

                result = await bridge.thread_delete({
                    "threadId": session.thread_id,
                    "cwd": workspace,
                    "deletePersistent": True,
                })

                self.assertTrue(result["deleted"])
                self.assertFalse(transcript.exists())
                self.assertTrue(unrelated.exists())
                self.assertNotIn(session.thread_id, bridge.sessions)
                self.assertNotIn(session.thread_id, bridge._session_map)
            finally:
                BRIDGE_MODULE.SESSION_MAP_PATH = previous_map
                if previous_home is None:
                    os.environ.pop("HOME", None)
                else:
                    os.environ["HOME"] = previous_home

    async def test_ephemeral_cleanup_survives_a_bridge_restart(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            previous_home = os.environ.get("HOME")
            previous_map = BRIDGE_MODULE.SESSION_MAP_PATH
            os.environ["HOME"] = temporary
            BRIDGE_MODULE.SESSION_MAP_PATH = os.path.join(temporary, "session-map.json")
            try:
                workspace = os.path.join(temporary, "restarted-label-job")
                os.makedirs(workspace)
                thread_id = "sticker-label-12345678"
                sdk_session_id = "sdk-session-after-restart"
                bridge = BRIDGE_MODULE.Bridge()
                bridge._session_map[thread_id] = sdk_session_id
                bridge._save_session_map()
                project_store = bridge._project_store_dir(workspace)
                os.makedirs(project_store)
                pathlib.Path(project_store, f"{sdk_session_id}.jsonl").write_text("history", encoding="utf-8")

                result = await bridge.thread_delete({
                    "threadId": thread_id,
                    "cwd": workspace,
                    "ephemeral": True,
                    "purgeProject": True,
                })

                self.assertTrue(result["deleted"])
                self.assertFalse(os.path.exists(project_store))
                self.assertNotIn(thread_id, bridge._session_map)
            finally:
                BRIDGE_MODULE.SESSION_MAP_PATH = previous_map
                if previous_home is None:
                    os.environ.pop("HOME", None)
                else:
                    os.environ["HOME"] = previous_home


if __name__ == "__main__":
    unittest.main()
