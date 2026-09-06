import assert from "node:assert/strict";

const base = process.argv[2] || "http://localhost:9876";
async function request(path, body) {
  const headers = body === undefined ? {} : { "content-type": "application/json" };
  if (process.env.CELLD_ID_TOKEN) headers.authorization = `Bearer ${process.env.CELLD_ID_TOKEN}`;
  const response = await fetch(base + "/sessions" + path, {
    headers,
    ...(body === undefined ? {} : {
      method: "POST", body: JSON.stringify(body),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await response.json();
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}
const { id } = await request("", {});
const marker = "cedar-" + Math.random().toString(36).slice(2, 8);
const first = await request(`/${id}/prompt`, { text: `Remember this label: ${marker}. Acknowledge briefly.` });
assert.equal(first.session.outcome, "succeeded");
assert.equal(first.messages.filter(message => message.type === "assistant").length, 1);
const loaded = await request(`/${id}`);
assert.equal(loaded.session.id, first.session.id);
assert.deepEqual(loaded.messages, first.messages);
const resumed = await request(`/${id}/prompt`, { text: "What label did I ask you to remember? Reply with just that label." });
assert.equal(resumed.session.outcome, "succeeded");
const replies = resumed.messages.filter(message => message.type === "assistant");
assert.equal(replies.length, 2);
const text = replies.at(-1).content.filter(part => part.type === "text").map(part => part.text).join("\n");
assert.ok(text.includes(marker), `Expected recalled label ${marker}; got ${text}`);
console.log(JSON.stringify({ result: "PASS", id, sdkSessionID: resumed.session.id, messages: resumed.messages.length, recalled: text }));
