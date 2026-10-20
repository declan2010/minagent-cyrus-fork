import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchOllamaModels, ollamaBasesForEndpoint, persistModelDefault, resolveModelSelection, sortModelNames } from "../src/model-switch.mjs";

test("model names sort alphabetically ignoring case", () => {
	const sorted = sortModelNames(["Zeta:latest", "alpha:7b", "Beta:7b", "alpha:7b"]);
	assert.deepEqual(sorted, ["alpha:7b", "Beta:7b", "Zeta:latest"]);
});

test("ollama bases strip /v1 and include the localhost fallback", () => {
	assert.deepEqual(ollamaBasesForEndpoint("http://127.0.0.1:11434/v1"), ["http://127.0.0.1:11434"]);
	assert.deepEqual(ollamaBasesForEndpoint("http://127.0.0.1:8777/v1"), ["http://127.0.0.1:8777", "http://127.0.0.1:11434"]);
});

test("fetchOllamaModels falls back to localhost:11434 and sorts names", async () => {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(url);
		if (url.startsWith("http://127.0.0.1:8777")) return { ok: false, status: 404 };
		return { ok: true, json: async () => ({ models: [{ name: "qwen3:0.6b" }, { name: "gemma4:26b" }] }) };
	};
	const names = await fetchOllamaModels("http://127.0.0.1:8777/v1", fetchImpl);
	assert.deepEqual(names, ["gemma4:26b", "qwen3:0.6b"]);
	assert.equal(calls.length, 2);
});

test("fetchOllamaModels throws when every base fails", async () => {
	const fetchImpl = async (url) => {
		if (url.startsWith("http://127.0.0.1:11434")) throw new Error("ECONNREFUSED");
		return { ok: false, status: 500 };
	};
	await assert.rejects(() => fetchOllamaModels("http://127.0.0.1:8777/v1", fetchImpl), /Could not list Ollama models/);
});

test("resolveModelSelection accepts numbers, exact names, and unique prefixes", () => {
	const names = ["gemma4:26b", "qwen3:32b", "qwen3:8b"];
	assert.equal(resolveModelSelection(names, "2").model, "qwen3:32b");
	assert.equal(resolveModelSelection(names, "gemma4:26b").model, "gemma4:26b");
	assert.equal(resolveModelSelection(names, "gemma").model, "gemma4:26b");
	const ambiguous = resolveModelSelection(names, "qwen3:");
	assert.ok(ambiguous.error && ambiguous.error.includes("ambiguous"));
	assert.deepEqual(ambiguous.candidates, ["qwen3:32b", "qwen3:8b"]);
	const missing = resolveModelSelection(names, "llama3");
	assert.ok(missing.error && missing.error.includes("not available"));
	assert.ok(resolveModelSelection(names, "99").error.includes("out of range"));
});

test("persistModelDefault replaces an existing OPENAI_MODEL and appends otherwise", async () => {
	const dir = await mkdtemp(join(tmpdir(), "minagent-model-"));
	try {
		const envPath = join(dir, ".env");
		await writeFile(envPath, "OPENAI_BASE_URL=http://127.0.0.1:11434/v1\nOPENAI_MODEL=old:model\n# keep me\n");
		await persistModelDefault(dir, "new:model");
		let text = await readFile(envPath, "utf8");
		assert.match(text, /^OPENAI_MODEL=new:model$/m);
		assert.ok(!text.includes("old:model"));
		assert.match(text, /OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:11434\/v1/);
		assert.match(text, /# keep me/);

		await writeFile(envPath, "OPENAI_BASE_URL=http://127.0.0.1:11434/v1");
		await persistModelDefault(dir, "another:model");
		text = await readFile(envPath, "utf8");
		assert.match(text, /^OPENAI_MODEL=another:model$/m);
		assert.match(text, /OPENAI_BASE_URL/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
