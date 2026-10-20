import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FALLBACK_OLLAMA_BASE = "http://127.0.0.1:11434";
const FETCH_TIMEOUT_MS = 3000;

export function ollamaBasesForEndpoint(endpoint) {
	const bases = [];
	try {
		const url = new URL(endpoint);
		const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
		bases.push(`${url.origin}${path}`);
	} catch {
		// Endpoint is not a valid URL; only the fallback base is usable.
	}
	if (!bases.includes(FALLBACK_OLLAMA_BASE)) bases.push(FALLBACK_OLLAMA_BASE);
	return bases;
}

export function sortModelNames(names) {
	return [...new Set(names)].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

export async function fetchOllamaModels(endpoint, fetchImpl = fetch) {
	const failures = [];
	for (const base of ollamaBasesForEndpoint(endpoint)) {
		try {
			const response = await fetchImpl(`${base}/api/tags`, {
				redirect: "error",
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!response.ok) {
				failures.push(`${base} → HTTP ${response.status}`);
				continue;
			}
			const data = await response.json();
			const names = (Array.isArray(data?.models) ? data.models : [])
				.map((entry) => {
					if (typeof entry?.name === "string") return entry.name;
					if (typeof entry?.model === "string") return entry.model;
					return "";
				})
				.filter(Boolean);
			if (names.length > 0) return sortModelNames(names);
			failures.push(`${base} → no models reported`);
		} catch (error) {
			failures.push(`${base} → ${error?.message || error}`);
		}
	}
	throw new Error(`Could not list Ollama models (${failures.join("; ")})`);
}

export function resolveModelSelection(names, arg) {
	const trimmed = (arg ?? "").trim();
	if (!trimmed) return { error: "No model specified." };
	if (/^\d+$/.test(trimmed)) {
		const index = Number(trimmed) - 1;
		if (index >= 0 && index < names.length) return { model: names[index] };
		return { error: `Selection #${trimmed} is out of range (1-${names.length}).`, candidates: names };
	}
	if (names.includes(trimmed)) return { model: trimmed };
	const lower = trimmed.toLowerCase();
	const matches = names.filter((name) => name.toLowerCase() === lower || name.toLowerCase().startsWith(lower));
	if (matches.length === 1) return { model: matches[0] };
	if (matches.length > 1) return { error: `\`${trimmed}\` is ambiguous: ${matches.length} models match.`, candidates: matches };
	return { error: `Model \`${trimmed}\` is not available on this Ollama server.`, candidates: names };
}

export async function persistModelDefault(applicationRoot, modelName, io = { readFile, writeFile }) {
	const envPath = join(applicationRoot, ".env");
	let contents = "";
	try {
		contents = await io.readFile(envPath, "utf8");
	} catch {
		contents = "";
	}
	const line = `OPENAI_MODEL=${modelName}`;
	let next;
	if (/^OPENAI_MODEL=/m.test(contents)) {
		next = contents.replace(/^OPENAI_MODEL=.*$/gm, () => line);
	} else {
		next = contents.length === 0 || contents.endsWith("\n") ? `${contents}${line}\n` : `${contents}\n${line}\n`;
	}
	await io.writeFile(envPath, next, "utf8");
	return envPath;
}
