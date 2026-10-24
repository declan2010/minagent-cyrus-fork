import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAiClient } from "../src/openai.mjs";
import { loadConfiguration } from "../src/config.mjs";

function listen(handler) {
	return new Promise((resolve) => {
		const server = createServer(handler);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

function close(server) {
	return new Promise((resolve) => server.close(resolve));
}

function ndjson(res, events) {
	res.writeHead(200, { "Content-Type": "application/x-ndjson" });
	for (const event of events) res.write(`${JSON.stringify(event)}\n`);
	res.end();
}

test("native Ollama mode posts to /api/chat with think and options.num_predict", async (t) => {
	let captured;
	const server = await listen(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		captured = { url: req.url, body: JSON.parse(body) };
		ndjson(res, [
			{ model: "qwen", message: { role: "assistant", content: "Hola" }, done: false },
			{ model: "qwen", message: { role: "assistant", content: ", mundo" }, done: false },
			{ model: "qwen", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 12, prompt_eval_count: 40 },
		]);
	});
	t.after(() => close(server));
	const client = createOpenAiClient({
		endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
		model: "qwen", tools: [], ollamaThink: "low",
	});
	const deltas = [];
	const result = await client.complete([{ role: "user", content: "hola" }], { maxTokens: 128, onTextDelta: (chunk) => deltas.push(chunk) });
	assert.equal(captured.url, "/api/chat");
	assert.equal(captured.body.think, "low");
	assert.equal(captured.body.stream, true);
	assert.deepEqual(captured.body.options, { num_predict: 128 });
	assert.equal(captured.body.messages[0].content, "hola");
	assert.equal(result.message.content, "Hola, mundo");
	assert.deepEqual(deltas, ["Hola", ", mundo"]);
	assert.equal(result.payload.finish_reason, "stop");
	assert.deepEqual(result.payload.usage, { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 });
});

test("native Ollama mode keeps the /v1 wire intact when the knob is off", async (t) => {
	let captured;
	const server = await listen(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		captured = { url: req.url, body: JSON.parse(body) };
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	});
	t.after(() => close(server));
	const client = createOpenAiClient({
		endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
		model: "qwen", tools: [],
	});
	const result = await client.complete([{ role: "user", content: "hola" }], { maxTokens: 7 });
	assert.equal(captured.url, "/v1/chat/completions");
	assert.equal(captured.body.think, undefined);
	assert.equal(captured.body.max_tokens, 7);
	assert.equal(result.message.content, "ok");
});

test("native tool calls survive full-so-far chunks, get synthetic ids and round-trip keeping ids", async (t) => {
	let captured;
	const server = await listen(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		captured = JSON.parse(body);
		ndjson(res, [
			{ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "run_terminal", arguments: '{"command":"l' } }] }, done: false },
			{ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "run_terminal", arguments: '{"command":"ls"}' } }] }, done: false },
			{ message: { role: "assistant", content: "" }, done: true, done_reason: "tool_calls", eval_count: 30, prompt_eval_count: 100 },
		]);
	});
	t.after(() => close(server));
	const client = createOpenAiClient({
		endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
		model: "qwen", tools: [], ollamaThink: "false",
	});
	const messages = [
		{ role: "user", content: "lista archivos" },
		{ role: "assistant", content: null, tool_calls: [{ id: "call_abc", type: "function", function: { name: "run_terminal", arguments: '{"command":"ls"}' } }] },
		{ role: "tool", tool_call_id: "call_abc", content: "archivo.txt" },
	];
	const result = await client.complete(messages, { withTools: true });
	assert.equal(result.message.tool_calls.length, 1);
	assert.equal(result.message.tool_calls[0].function.name, "run_terminal");
	assert.equal(result.message.tool_calls[0].function.arguments, '{"command":"ls"}');
	assert.equal(result.message.tool_calls[0].id, "call_0");
	assert.equal(result.payload.finish_reason, "tool_calls");
	// Round-trip: arguments como objeto (exigencia del renderer custom) y id/type PRESERVADOS:
	// el puente cloud asocia tool_call_id ↔ tool_call por id; sin id descarta el resultado.
	const [, assistant, tool] = captured.messages;
	assert.deepEqual(assistant.tool_calls, [{ id: "call_abc", type: "function", function: { name: "run_terminal", arguments: { command: "ls" } } }]);
	assert.equal(tool.role, "tool");
	assert.equal(tool.content, "archivo.txt");
});

test("native streaming forwards thinking deltas and labels stream failures", async (t) => {
	const server = await listen((req, res) => {
		ndjson(res, [
			{ message: { role: "assistant", thinking: "debo contestar", content: "" }, done: false },
			{ message: { role: "assistant", thinking: " corto", content: "listo" }, done: false },
			{ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 5, prompt_eval_count: 9 },
		]);
	});
	t.after(() => close(server));
	const client = createOpenAiClient({
		endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
		model: "qwen", tools: [], ollamaThink: "true",
	});
	const reasoning = [];
	const result = await client.complete([{ role: "user", content: "x" }], { onReasoningDelta: (chunk) => reasoning.push(chunk) });
	assert.deepEqual(reasoning, ["debo contestar", " corto"]);
	assert.equal(result.message.content, "listo");
});

test("native mode labels mid-stream errors and truncated streams for recovery", async (t) => {
	const errorServer = await listen((req, res) => {
		ndjson(res, [{ error: "model is loading" }]);
	});
	t.after(() => close(errorServer));
	const errorClient = createOpenAiClient({
		endpoint: `http://127.0.0.1:${errorServer.address().port}/v1/chat/completions`,
		model: "qwen", tools: [], ollamaThink: "false",
	});
	await assert.rejects(errorClient.complete([{ role: "user", content: "x" }]), { code: "STREAM_ERROR" });

	const truncatedServer = await listen((req, res) => {
		res.writeHead(200, { "Content-Type": "application/x-ndjson" });
		res.write(`${JSON.stringify({ message: { role: "assistant", content: "a" }, done: false })}\n`);
		res.end();
	});
	t.after(() => close(truncatedServer));
	const truncatedClient = createOpenAiClient({
		endpoint: `http://127.0.0.1:${truncatedServer.address().port}/v1/chat/completions`,
		model: "qwen", tools: [], ollamaThink: "false",
	});
	await assert.rejects(truncatedClient.complete([{ role: "user", content: "x" }]), { code: "STREAM_ENDED" });

	const jsonServer = await listen((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "runner muerto" }));
	});
	t.after(() => close(jsonServer));
	const jsonClient = createOpenAiClient({
		endpoint: `http://127.0.0.1:${jsonServer.address().port}/v1/chat/completions`,
		model: "qwen", tools: [], ollamaThink: "false",
	});
	await assert.rejects(jsonClient.complete([{ role: "user", content: "x" }]), { code: "ENDPOINT_SHAPE" });
});

test("cloud bridge: NDJSON stream labeled application/json parses as a native stream", async (t) => {
	const server = await listen((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.write(`${JSON.stringify({ model: "minimax-m3", message: { role: "assistant", thinking: "debo", content: "" }, done: false })}\n`);
		res.write(`${JSON.stringify({ model: "minimax-m3", message: { role: "assistant", content: "Hola" }, done: false })}\n`);
		res.write(`${JSON.stringify({ model: "minimax-m3", message: { role: "assistant", content: "!" }, done: true, done_reason: "stop", eval_count: 7, prompt_eval_count: 11 })}\n`);
		res.end();
	});
	t.after(() => close(server));
	const client = createOpenAiClient({
		endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
		model: "minimax-m3:cloud", tools: [], ollamaThink: "low",
	});
	const deltas = [];
	const reasoning = [];
	const result = await client.complete([{ role: "user", content: "hola" }], { onTextDelta: (chunk) => deltas.push(chunk), onReasoningDelta: (chunk) => reasoning.push(chunk) });
	assert.deepEqual(deltas, ["Hola", "!"]);
	assert.deepEqual(reasoning, ["debo"]);
	assert.equal(result.message.content, "Hola!");
	assert.equal(result.payload.finish_reason, "stop");
	assert.deepEqual(result.payload.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
});

test("cloud bridge: a lone error keeps ENDPOINT_SHAPE, mid-stream errors stay STREAM_ERROR", async (t) => {
	const lone = await listen((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(`${JSON.stringify({ error: "runner muerto" })}\n`);
	});
	t.after(() => close(lone));
	const loneClient = createOpenAiClient({
		endpoint: `http://127.0.0.1:${lone.address().port}/v1/chat/completions`,
		model: "qwen", tools: [], ollamaThink: "low",
	});
	await assert.rejects(loneClient.complete([{ role: "user", content: "x" }]), (error) => error.code === "ENDPOINT_SHAPE" && error.message.includes("runner muerto"));

	const midStream = await listen((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.write(`${JSON.stringify({ message: { role: "assistant", content: "par" }, done: false })}\n`);
		res.write(`${JSON.stringify({ error: "upstream went away" })}\n`);
		res.end();
	});
	t.after(() => close(midStream));
	const midClient = createOpenAiClient({
		endpoint: `http://127.0.0.1:${midStream.address().port}/v1/chat/completions`,
		model: "qwen", tools: [], ollamaThink: "low",
	});
	await assert.rejects(midClient.complete([{ role: "user", content: "x" }]), (error) => error.code === "STREAM_ERROR" && error.message.includes("upstream went away"));
});

test("OPENAI_OLLAMA_THINK parsing accepts levels and aliases, rejects junk", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "minagent-think-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const load = (env = {}) => loadConfiguration({ appDirectory: join(root, "src"), cwd: root, env: { OPENAI_MODEL: "test", ...env } });
	assert.equal((await load()).ollamaThink, undefined);
	assert.equal((await load({ OPENAI_OLLAMA_THINK: "" })).ollamaThink, undefined);
	assert.equal((await load({ OPENAI_OLLAMA_THINK: "low" })).ollamaThink, "low");
	assert.equal((await load({ OPENAI_OLLAMA_THINK: "false" })).ollamaThink, "false");
	assert.equal((await load({ OPENAI_OLLAMA_THINK: "off" })).ollamaThink, "false");
	assert.equal((await load({ OPENAI_OLLAMA_THINK: "ON" })).ollamaThink, "true");
	await assert.rejects(load({ OPENAI_OLLAMA_THINK: "banana" }), /OPENAI_OLLAMA_THINK/);
	await assert.rejects(load({ OPENAI_OLLAMA_THINK: "LOW!!" }), /OPENAI_OLLAMA_THINK/);
});
