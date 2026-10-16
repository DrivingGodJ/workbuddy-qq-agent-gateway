"""Offline regression checks: real native previews, no QQ/model/HA calls."""
import asyncio
import base64
import hashlib
import importlib.util
import json
import pathlib
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import zlib
from unittest.mock import AsyncMock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('preview_bridge', ROOT / 'modules/workbuddy-agent/bridge.py')
BRIDGE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BRIDGE
SPEC.loader.exec_module(BRIDGE)


def png(width, height):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    pixels = (b'\x00' + b'\x22\x44\x66' * width) * height
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')


class PreviewTests(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(pathlib.Path(BRIDGE.SIPS_PATH).is_file(), 'macOS native converter required')
    def test_small_gif_is_a_bounded_jpeg_preview_not_the_original_animation(self):
        with tempfile.TemporaryDirectory() as directory:
            original = pathlib.Path(directory, 'original.gif')
            original.write_bytes(base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'))
            before = original.read_bytes()
            data, mime, optimized = BRIDGE.Bridge._prepare_prompt_image(str(original), 64*1024, directory, 0)
            self.assertEqual(mime, 'image/jpeg')
            self.assertTrue(optimized)
            self.assertTrue(data.startswith(b'\xff\xd8'))
            self.assertLessEqual(len(data), 64*1024)
            self.assertEqual(original.read_bytes(), before)

    @unittest.skipUnless(pathlib.Path(BRIDGE.SIPS_PATH).is_file(), 'macOS native converter required')
    def test_small_bytes_with_huge_dimensions_are_still_resized(self):
        with tempfile.TemporaryDirectory() as directory:
            original = pathlib.Path(directory, 'wide.png')
            original.write_bytes(png(4096, 64))
            original_hash = hashlib.sha256(original.read_bytes()).hexdigest()
            data, mime, optimized = BRIDGE.Bridge._prepare_prompt_image(str(original), 64*1024, directory, 0)
            self.assertEqual(mime, 'image/jpeg')
            self.assertTrue(optimized)
            preview = pathlib.Path(directory, 'verified.jpg')
            preview.write_bytes(data)
            result = subprocess.run([BRIDGE.SIPS_PATH, '-g', 'pixelWidth', '-g', 'pixelHeight', str(preview)], capture_output=True, check=True)
            import re
            self.assertTrue(all(0 < int(v) <= 1280 for v in re.findall(rb'pixel(?:Width|Height):\s*(\d+)', result.stdout)))
            self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(), original_hash)

    @unittest.skipUnless(pathlib.Path(BRIDGE.SIPS_PATH).is_file(), 'macOS native converter required')
    def test_safe_png_is_not_reencoded_and_total_base64_decodes_within_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            original = pathlib.Path(directory, 'small.png')
            original.write_bytes(png(32, 16))
            data, mime, optimized = BRIDGE.Bridge._prepare_prompt_image(str(original), 64*1024, directory, 0)
            self.assertFalse(optimized)
            self.assertEqual(data, original.read_bytes())
            payload = BRIDGE.Bridge._build_prompt('offline test', [str(original)] * 50)
            images = [x for x in payload['message']['content'] if x['type'] == 'image']
            self.assertLessEqual(len(images), BRIDGE.MAX_PROMPT_IMAGE_COUNT)
            self.assertLessEqual(sum(len(base64.b64decode(x['source']['data'])) for x in images), BRIDGE.MAX_PROMPT_IMAGE_RAW_BYTES)

    def test_expired_image_budget_cannot_start_another_conversion(self):
        with tempfile.TemporaryDirectory() as directory:
            original = pathlib.Path(directory, 'image.gif')
            original.write_bytes(b'not decoded because time is expired')
            with patch.object(BRIDGE.subprocess, 'run') as conversion:
                self.assertIsNone(BRIDGE.Bridge._prepare_prompt_image(str(original), 64*1024, directory, 0, time.monotonic()-1))
            conversion.assert_not_called()

    async def test_preprocessing_does_not_block_interrupt_event_loop(self):
        bridge = BRIDGE.Bridge()
        class Client:
            query = AsyncMock()
        client = Client()
        def slow_payload(*args):
            time.sleep(0.15)
            return 'prepared'
        with patch.object(bridge, '_prompt_payload', side_effect=slow_payload):
            task = asyncio.create_task(bridge._send_prompt(client, 'offline', ['image']))
            await asyncio.sleep(0.02)
            self.assertFalse(task.done(), 'event loop must run while image worker is busy')
            await task
        client.query.assert_awaited_once_with('prepared')

    async def test_native_tool_attempt_is_reported_before_execution_and_late_calls_stop(self):
        import codebuddy_agent_sdk
        bridge = BRIDGE.Bridge()
        session = BRIDGE.Session('offline-thread', '/tmp')
        class Client:
            connect = AsyncMock()
        with patch.object(codebuddy_agent_sdk, 'CodeBuddySDKClient', return_value=Client()) as factory:
            await bridge._make_client(session)
        hook = factory.call_args.kwargs['options'].hooks['PreToolUse'][0].hooks[0]
        turn = BRIDGE.Turn(session.thread_id, 'offline-turn', 'offline-group')
        bridge.turns[turn.turn_id] = turn
        events = []
        with patch.object(BRIDGE, 'emit', side_effect=events.append):
            result = await hook({'tool_name': 'Bash'}, None, {})
            self.assertTrue(result['continue_'])
            self.assertEqual(events[-1]['params']['name'], 'Bash')
            await hook({'tool_name': 'DeferExecuteTool', 'tool_input': {'toolName': 'mcp__qq_gateway__send_message'}}, None, {})
            self.assertEqual(events[-1]['params']['name'], 'mcp__qq_gateway__send_message')
            turn.cancelled = True
            self.assertFalse((await hook({'tool_name': 'Bash'}, None, {}))['continue_'])
            self.assertEqual(len(events), 2)


if __name__ == '__main__':
    unittest.main()
