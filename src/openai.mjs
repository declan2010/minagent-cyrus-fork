import { modelsEndpoint, normalizeModelCatalog } from "./models.mjs";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 1024 * 1024;
const RETRYABLE_NETWORK_ERRORS = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
const GLOBAL_DISPATCHER_KEY = Symbol.for("undici.globalDispatcher.1");
let dispatcherProbed = false;

function applyIdleTimeoutsIn(node, seen, idleMs) {
	if (!node || typeof node !== "object" || seen.has(node)) return;
	seen.add(node);
	for (const sym of Object.getOwnPropertySymbols(node)) {
		const desc = sym.description ?? "";
		const value = node[sym];
		if (desc === "body timeout" || desc === "headers timeout") {
			node[sym] = idleMs;
		} else if (desc === "options" && value && typeof value === "object" && !Array.isArray(value)) {
			value.headersTimeout = idleMs;
			value.bodyTimeout = idleMs;
		} else if (desc === "clients" && value) {
			if (value instanceof Map) {
				for (const child of value.values()) applyIdleTimeoutsIn(child, seen, idleMs);
			} else if (Array.isArray(value)) {
				for (const child of value) applyIdleTimeoutsIn(child, seen, idleMs);
			}
		}
	}
}

async function configureIdleTimeouts(idleMs) {
	if (!globalThis[GLOBAL_DISPATCHER_KEY] && !dispatcherProbed) {
		try {
			await globalThis.fetch("http://127.0.0.1:1/", { signal: AbortSignal.timeout(50) });
		} catch {}
		dispatcherProbed = true;
	}
	const root = globalThis[GLOBAL_DISPATCHER_KEY];
	if (root) applyIdleTimeoutsIn(root, new Set(), idleMs);
}

export function createOpenAiClient({ endpoint, apiKey, model, tools, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, ollamaThink }) {
	if (!endpoint || !model || !Array.isArray(tools)) throw new Error("OpenAI client configuration is incomplete.");
	return {
		listModels: async ({ signal, timeoutMs: catalogTimeoutMs = 15_000 } = {}) => {
			const headers = { Accept: "application/json" };
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
			const timeoutSignal = AbortSignal.timeout(catalogTimeoutMs);
			const response = await fetch(modelsEndpoint(endpoint), {
				headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new Error(`Could not list models: HTTP ${response.status}${response.status === 404 || response.status === 405 ? " (this server does not expose a model catalog)" : ""}.`);
			}
			const body = await readResponsePrefix(response, 1024 * 1024, signal);
			let payload;
			try { payload = JSON.parse(body); }
			catch { throw new Error("The API returned an invalid or oversized model catalog."); }
			return normalizeModelCatalog(payload);
		},
		complete: async (requestMessages, options = {}) => {
			await configureIdleTimeouts(timeoutMs);
			const headers = { "Content-Type": "application/json" };
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
			// OPENAI_OLLAMA_THINK activa el modo nativo de Ollama (/api/chat), único canal que entiende "think".
			const nativeTarget = ollamaThink === undefined ? undefined : ollamaChatUrl(endpoint);
			const requestBody = nativeTarget
				? { model, messages: toOllamaMessages(requestMessages), stream: true, think: ollamaThinkValue(ollamaThink) }
				: { model, messages: requestMessages, stream: true };
			if (options.withTools) {
				requestBody.tools = options.availableTools ?? tools;
				requestBody.tool_choice = options.toolChoice ?? "auto";
			}
			if (options.maxTokens) {
				if (nativeTarget) requestBody.options = { num_predict: options.maxTokens };
				else requestBody.max_tokens = options.maxTokens;
			}
			const signals = [];
			if (options.signal) signals.push(options.signal);
			if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
			const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
			let response;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				try {
					response = await fetch(nativeTarget ?? endpoint, {
						method: "POST",
						headers,
						body: JSON.stringify(requestBody),
						redirect: "error",
						signal,
					});
					break;
				} catch (error) {
					if (options.signal?.aborted) throw error;
					const code = error?.cause?.code;
					if (attempt === 0 && RETRYABLE_NETWORK_ERRORS.has(code)) {
						await waitForRetryDelay(options.signal);
						continue;
					}
					const cause = code ? ` (${code})` : error?.cause?.message ? ` (${error.cause.message})` : "";
					throw Object.assign(new Error(`Could not connect to the OpenAI-compatible endpoint: ${error.message}${cause}`), { code: "ENDPOINT_CONNECT" });
				}
			}
			if (!response.ok) {
				const bodyText = await readResponsePrefix(response, 8 * 1024, options.signal);
				throw Object.assign(new Error(`Endpoint returned HTTP ${response.status}: ${bodyText}`), { code: "HTTP_ERROR", httpStatus: response.status });
			}
			const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
			if (nativeTarget) {
				// Ollama nativo responde NDJSON; JSON o SSE significan otra cosa (runner caído, proxy raro…).
				if (!contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
					return readOllamaStreamingResponse(response, options.onTextDelta, maxResponseBytes, options.onReasoningDelta, options.signal, options.onToolCallDelta);
				}
			} else if (contentType.includes("text/event-stream")) {
				return readStreamingResponse(response, options.onTextDelta, maxResponseBytes, options.onReasoningDelta, options.signal, options.onToolCallDelta);
			}
			const bodyText = await readResponsePrefix(response, 2 * 1024, options.signal);
			const expected = nativeTarget ? "streaming NDJSON" : "streaming";
			throw Object.assign(new Error(`The endpoint did not return a ${expected} response (Content-Type: ${contentType || "unknown"}). Response: ${bodyText}`), { code: "ENDPOINT_SHAPE" });
		},
	};
}

// Convierte un endpoint .../v1/chat/completions en .../api/chat sobre el mismo host.
function ollamaChatUrl(endpoint) {
	try {
		const url = new URL(endpoint);
		let path = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/v1$/, "");
		return `${url.origin}${path}/api/chat`;
	} catch {
		return undefined;
	}
}

function ollamaThinkValue(level) {
	if (level === "false") return false;
	if (level === "true") return true;
	return level;
}

// Ajusta mensajes OpenAI al formato nativo de Ollama: tool_calls sin id/type y contenido no-string serializado.
// El renderer custom exige arguments como OBJETO JSON (string crudo → HTTP 400 "can't find closing '}'").
function toOllamaMessages(messages) {
	return messages.map((message) => {
		const mapped = { ...message };
		if (mapped.role === "developer") mapped.role = "system";
		if (mapped.content != null && typeof mapped.content !== "string" && !Array.isArray(mapped.content)) {
			mapped.content = JSON.stringify(mapped.content);
		}
		if (Array.isArray(message.tool_calls)) {
			mapped.tool_calls = message.tool_calls.map((call) => {
				const raw = call?.function?.arguments;
				let parsed;
				if (raw && typeof raw === "object" && !Array.isArray(raw)) parsed = raw;
				else if (typeof raw === "string") {
					try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) parsed = undefined;
				}
				const fn = { name: call?.function?.name ?? "" };
				if (parsed !== undefined) fn.arguments = parsed;
				return { function: fn };
			});
		}
		return mapped;
	});
}

function waitForRetryDelay(signal) {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, 250));
	if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, 250);
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

async function readResponsePrefix(response, maxBytes, signal) {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks = [];
	let totalBytes = 0;
	let truncated = false;
	try {
		while (totalBytes < maxBytes) {
			const { value, done } = await reader.read();
			if (done) break;
			const keep = value.subarray(0, maxBytes - totalBytes);
			chunks.push(Buffer.from(keep));
			totalBytes += keep.byteLength;
			if (keep.byteLength < value.byteLength) {
				truncated = true;
				break;
			}
		}
		if (totalBytes >= maxBytes) truncated = true;
	} finally {
		if (truncated) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
	return `${Buffer.concat(chunks, totalBytes).toString("utf8")}${truncated ? " [response excerpt truncated]" : ""}`;
}

export async function readStreamingResponse(response, onTextDelta, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, onReasoningDelta, signal, onToolCallDelta) {
	if (!response.body) throw new Error("Endpoint opened a streaming response without a readable body.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const toolCalls = new Map();
	let buffer = "";
	let content = "";
	let usage;
	let finishReason;
	let finished = false;
	let bytesRead = 0;
	let bodyDone = false;
	let interrupted = false;

	function consumeFrame(frame) {
		const data = frame.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") {
			if (data === "[DONE]") finished = true;
			return;
		}
		let event;
		try {
			event = JSON.parse(data);
		} catch {
			throw new Error("Endpoint sent an invalid streaming event.");
		}
		if (event?.error) {
			const detail = typeof event.error === "string" ? event.error : JSON.stringify(event.error);
			throw Object.assign(new Error(`Endpoint streaming error: ${detail.slice(0, 1000)}`), { code: "STREAM_ERROR" });
		}
		if (event?.usage) usage = event.usage;
		const choice = event?.choices?.[0];
		if (!choice) return;
		if (choice.finish_reason) finishReason = choice.finish_reason;
		const delta = choice.delta ?? {};
		const reasoningDelta = typeof delta.reasoning_summary === "string" && delta.reasoning_summary
			? delta.reasoning_summary
			: typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
		if (reasoningDelta) {
			onReasoningDelta?.(reasoningDelta);
		}
		if (typeof delta.content === "string" && delta.content) {
			content += delta.content;
			onTextDelta?.(delta.content);
		} else if (Array.isArray(delta.content)) {
			for (const part of delta.content) {
				if (typeof part?.text === "string" && part.text) {
					content += part.text;
					onTextDelta?.(part.text);
				}
			}
		}
		for (const deltaCall of delta.tool_calls ?? []) {
			const index = Number.isInteger(deltaCall.index) ? deltaCall.index : toolCalls.size;
			const call = toolCalls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
			if (deltaCall.id) call.id = deltaCall.id;
			if (deltaCall.type) call.type = deltaCall.type;
			if (deltaCall.function?.name) {
				call.function.name += deltaCall.function.name;
				onToolCallDelta?.({ index, name: call.function.name });
			}
			if (deltaCall.function?.arguments) {
				call.function.arguments += deltaCall.function.arguments;
				if (call.function.arguments.length > MAX_TOOL_ARGUMENT_CHARS) throw new Error("Endpoint returned tool arguments larger than the 1 MiB limit.");
				onToolCallDelta?.({ index, name: call.function.name });
			}
			toolCalls.set(index, call);
		}
	}

	try {
		while (!finished) {
			const { value, done } = await reader.read();
			if (done) {
				bodyDone = true;
				break;
			}
			bytesRead += value.byteLength;
			if (bytesRead > maxResponseBytes) throw new Error(`Endpoint streaming response exceeds the ${maxResponseBytes} byte limit.`);
			buffer += decoder.decode(value, { stream: true });
			let boundary;
			while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
				const frame = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				consumeFrame(frame);
				if (finished) break;
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) consumeFrame(buffer);
		if (!finished && !finishReason) throw Object.assign(new Error("Endpoint stream ended before a complete response was received."), { code: "STREAM_ENDED" });
	} catch (error) {
		if (signal?.aborted) interrupted = true;
		else throw error;
	} finally {
		if (!bodyDone) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	if (interrupted) {
		return {
			payload: { usage, finish_reason: "aborted" },
			message: { role: "assistant", content: content || null, interrupted: true },
		};
	}

	const message = { role: "assistant", content: content || null };
	if (toolCalls.size > 0) message.tool_calls = [...toolCalls.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, call]) => call);
	if (finishReason === "length") throw new Error("Endpoint stopped at its output token limit; the partial response was discarded.");
	if (finishReason === "content_filter") throw new Error("Endpoint stopped the response because of its content filter.");
	for (const call of message.tool_calls ?? []) {
		if (!call.id || !call.function.name) throw Object.assign(new Error("Endpoint returned an incomplete tool call."), { code: "INVALID_TOOL_CALL" });
		try {
			const args = JSON.parse(call.function.arguments);
			if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
		} catch {
			throw Object.assign(new Error(`Endpoint returned invalid arguments for tool ${call.function.name}.`), { code: "INVALID_TOOL_CALL" });
		}
	}
	return { payload: { usage, finish_reason: finishReason }, message };
}

// Parser NDJSON para /api/chat de Ollama: un JSON por línea; el chunk final lleva done:true y las estadísticas.
export async function readOllamaStreamingResponse(response, onTextDelta, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, onReasoningDelta, signal, onToolCallDelta) {
	if (!response.body) throw new Error("Endpoint opened a streaming response without a readable body.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const toolCalls = new Map();
	let buffer = "";
	let content = "";
	let usage;
	let finishReason;
	let finished = false;
	let bytesRead = 0;
	let bodyDone = false;
	let interrupted = false;

	function consumeLine(line) {
		const trimmed = line.trim();
		if (!trimmed) return;
		let event;
		try {
			event = JSON.parse(trimmed);
		} catch {
			throw new Error("Endpoint sent an invalid streaming event.");
		}
		if (event?.error) {
			const detail = typeof event.error === "string" ? event.error : JSON.stringify(event.error);
			throw Object.assign(new Error(`Endpoint streaming error: ${detail.slice(0, 1000)}`), { code: "STREAM_ERROR" });
		}
		// El mensaje se procesa aunque venga en el chunk done (algunos builds mandan contenido ahí al final).
		const message = event?.message;
		if (message && typeof message === "object") {
			if (typeof message.thinking === "string" && message.thinking) onReasoningDelta?.(message.thinking);
			if (typeof message.content === "string" && message.content) {
				content += message.content;
				onTextDelta?.(message.content);
			}
			const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
			for (const [position, incoming] of calls.entries()) {
				const index = Number.isInteger(incoming?.index) ? incoming.index : position;
				const name = typeof incoming?.function?.name === "string" ? incoming.function.name : "";
				const rawArgs = incoming?.function?.arguments;
				const args = typeof rawArgs === "string" ? rawArgs : rawArgs === undefined ? "" : JSON.stringify(rawArgs);
				const existing = toolCalls.get(index);
				if (existing && name.startsWith(existing.function.name) && args.startsWith(existing.function.arguments)) {
					// El chunk repite la llamada completa hasta ahora (acumulada); reemplazar en vez de duplicar.
					existing.function.name = name;
					existing.function.arguments = args;
				} else {
					const call = existing ?? { id: `call_${index}`, type: "function", function: { name: "", arguments: "" } };
					call.function.name += name;
					call.function.arguments += args;
					if (call.function.arguments.length > MAX_TOOL_ARGUMENT_CHARS) throw new Error("Endpoint returned tool arguments larger than the 1 MiB limit.");
					toolCalls.set(index, call);
				}
				onToolCallDelta?.({ index, name: toolCalls.get(index).function.name });
			}
		}
		if (event?.done) {
			finished = true;
			if (typeof event.done_reason === "string" && event.done_reason) finishReason = event.done_reason === "abort" ? "aborted" : event.done_reason;
			const promptTokens = Number.isFinite(event.prompt_eval_count) ? event.prompt_eval_count : undefined;
			const completionTokens = Number.isFinite(event.eval_count) ? event.eval_count : undefined;
			if (promptTokens !== undefined || completionTokens !== undefined) {
				usage = {
					prompt_tokens: promptTokens ?? 0,
					completion_tokens: completionTokens ?? 0,
					total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
				};
			}
		}
	}

	try {
		while (!finished) {
			const { value, done } = await reader.read();
			if (done) {
				bodyDone = true;
				break;
			}
			bytesRead += value.byteLength;
			if (bytesRead > maxResponseBytes) throw new Error(`Endpoint streaming response exceeds the ${maxResponseBytes} byte limit.`);
			buffer += decoder.decode(value, { stream: true });
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				consumeLine(line);
				if (finished) break;
			}
		}
		if (!finished) {
			buffer += decoder.decode();
			if (buffer.trim()) consumeLine(buffer);
		}
		if (!finished && !finishReason) throw Object.assign(new Error("Endpoint stream ended before a complete response was received."), { code: "STREAM_ENDED" });
	} catch (error) {
		if (signal?.aborted) interrupted = true;
		else throw error;
	} finally {
		if (!bodyDone) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	if (interrupted) {
		return {
			payload: { usage, finish_reason: "aborted" },
			message: { role: "assistant", content: content || null, interrupted: true },
		};
	}

	const message = { role: "assistant", content: content || null };
	if (toolCalls.size > 0) message.tool_calls = [...toolCalls.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, call]) => call);
	if (finishReason === "length") throw new Error("Endpoint stopped at its output token limit; the partial response was discarded.");
	if (finishReason === "content_filter") throw new Error("Endpoint stopped the response because of its content filter.");
	for (const call of message.tool_calls ?? []) {
		if (!call.function.name) throw Object.assign(new Error("Endpoint returned an incomplete tool call."), { code: "INVALID_TOOL_CALL" });
		try {
			const args = JSON.parse(call.function.arguments);
			if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
		} catch {
			throw Object.assign(new Error(`Endpoint returned invalid arguments for tool ${call.function.name}.`), { code: "INVALID_TOOL_CALL" });
		}
	}
	return { payload: { usage, finish_reason: finishReason }, message };
}
