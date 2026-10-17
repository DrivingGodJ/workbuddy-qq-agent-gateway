import test from "node:test";
import assert from "node:assert/strict";
import { OneBotClient } from "../src/qq/onebot-client.js";

test("native favorite deletion validates its ID and requires explicit protocol success", async () => {
  const requests = [];
  let body = { status: "ok", retcode: 0, data: null };
  const client = new OneBotClient({ fetchImpl: async (url, options) => {
    requests.push({ url, input: JSON.parse(options.body), signal: options.signal });
    return { ok: true, status: 200, json: async () => body };
  } });
  assert.deepEqual(await client.deleteCustomFace("native-id"), { ok: true });
  assert.deepEqual(requests[0].input, { emoji_id: "native-id" });
  assert.ok(requests[0].url.endsWith("/delete_custom_face"));
  assert.ok(requests[0].signal instanceof AbortSignal);
  await assert.rejects(client.deleteCustomFace(" "), /无效/);
  assert.equal(requests.length, 1);
  for (const invalid of [{}, { status: "ok" }, { status: "ok", retcode: null }, { status: "ok", retcode: 1200 }]) {
    body = invalid;
    await assert.rejects(client.deleteCustomFace("native-id"));
  }
});
