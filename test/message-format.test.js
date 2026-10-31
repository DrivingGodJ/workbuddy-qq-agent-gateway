import test from 'node:test';
import assert from 'node:assert/strict';
import { handleQqMcpTool, messageFormatError } from '../src/qq/mcp-actions.js';

test('unpaired text wrapper is rejected before queueing and corrected text can be sent', () => {
  for (const args of [
    { text: '我知道了</text>' },
    { text: '</text>' },
    { segments: [{ type: 'text', text: '我知道了</te' }, { type: 'text', text: 'xt>' }] }
  ]) {
    const queued = [];
    const context = { allowMessage: true };
    assert.equal(handleQqMcpTool({ name: 'send_message', args, context, queued }).isError, true);
    assert.equal(queued.length, 0);
    assert.ok(!handleQqMcpTool({ name: 'send_message', args: { text: '我知道了' }, context, queued }).isError);
    assert.equal(queued[0].text, '我知道了');
  }
});

test('literal markup and ordinary punctuation are preserved', () => {
  for (const text of ['标签是 `</text>`', '引用“</text>”', '```xml\n</text>\n```', '<text>例子</text>', '行，知道了🙂']) {
    assert.equal(messageFormatError(text), null);
    const queued = [];
    handleQqMcpTool({ name: 'send_message', args: { text }, context: { allowMessage: true }, queued });
    assert.equal(queued[0].text, text);
  }
});
