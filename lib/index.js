import { homedir, networkInterfaces } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { createWriteStream, promises } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import Schema from "@deepseek-ai/schemastery";
import { access, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { createConnection, createServer, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { createSocket } from "node:dgram";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { basename as basename$1, dirname as dirname$1 } from "node:path/posix";
import { PassThrough, Readable } from "node:stream";
import ssh2, { Client } from "ssh2";
import { pipeline } from "node:stream/promises";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { WebSocketServer } from "ws";
//#region src/wait-policy.ts
/** 可调参数及边界（见方案 3.4 参数表）。 */
const WAIT_LIMITS = {
	quietMs: {
		min: 100,
		max: 5e3,
		default: 500
	},
	timeoutMs: {
		min: 1e3,
		max: 3e5,
		default: 3e4
	},
	outputCapBytes: { default: 262144 }
};
function assertRange(value, min, max, name) {
	if (!Number.isFinite(value) || value < min || value > max) throw new Error(`wait-policy: ${name} 必须在 ${min}–${max} 之间，收到 ${value}`);
}
/** 一次等待的完整状态。每个 tm_send 独占一个实例。 */
var WaitPolicy = class {
	quietMs;
	timeoutMs;
	cap;
	prompt;
	buffer = "";
	isTruncated = false;
	startedAt;
	lastOutputAt;
	constructor(config = {}) {
		this.quietMs = config.quietMs ?? WAIT_LIMITS.quietMs.default;
		this.timeoutMs = config.timeoutMs ?? WAIT_LIMITS.timeoutMs.default;
		this.cap = config.outputCapBytes ?? WAIT_LIMITS.outputCapBytes.default;
		assertRange(this.quietMs, WAIT_LIMITS.quietMs.min, WAIT_LIMITS.quietMs.max, "quietMs");
		assertRange(this.timeoutMs, WAIT_LIMITS.timeoutMs.min, WAIT_LIMITS.timeoutMs.max, "timeoutMs");
		if (config.promptPattern !== void 0) try {
			this.prompt = new RegExp(config.promptPattern);
		} catch (cause) {
			throw new Error(`wait-policy: promptPattern 不是合法正则: ${String(cause)}`);
		}
	}
	/** 开始计时。 */
	start(nowMs) {
		this.startedAt = nowMs;
	}
	/** 喂一段输出；命中提示符立即返回 'prompt'。 */
	feed(chunk, nowMs) {
		if (chunk.length > 0) {
			this.lastOutputAt = nowMs;
			this.append(chunk);
		}
		if (this.prompt !== void 0 && this.prompt.test(this.buffer)) return "prompt";
	}
	/** 按时间检查静默/超时；未开始返回 undefined。 */
	poll(nowMs) {
		if (this.startedAt === void 0) return void 0;
		if (this.lastOutputAt !== void 0 && nowMs - this.lastOutputAt >= this.quietMs) return "quiet";
		if (nowMs - this.startedAt >= this.timeoutMs) return "timeout";
	}
	/** 截至目前的累计输出（可能已截断）。 */
	output() {
		return this.buffer;
	}
	/** 是否因超过上限被截断。 */
	truncated() {
		return this.isTruncated;
	}
	append(chunk) {
		this.buffer += chunk;
		if (this.buffer.length > this.cap) {
			this.buffer = this.buffer.slice(this.buffer.length - this.cap);
			this.isTruncated = true;
		}
	}
};
//#endregion
//#region src/connection-store.ts
/**
* B1 连接存储 —— 设备清单的"档案室"。
*
* 连接配置的增删改查 + 校验 + JSON 落盘（权限尽力限为仅本人，含 Windows 尽力处理）。
* 只依赖文件系统，是最底层模块。校验错误永远不回显凭据内容。
* @module dsh-terminal-manager/connection-store
*/
/**
* Telnet 模式归一化：旧值 `'telnet'` → `'active'`；合法新值原样返回；
* 未知/非法值 → undefined（落盘数据按缺省 passive 处理，不阻断加载）。
*/
function normalizeTelnetMode$1(mode) {
	if (mode === "passive" || mode === "active" || mode === "raw") return mode;
	if (mode === "telnet") return "active";
}
const TELNET_MODE_INPUTS = /* @__PURE__ */ new Set([
	"passive",
	"active",
	"raw",
	"telnet"
]);
/** 校验失败（错误消息不含任何凭据内容）。 */
var StoreValidationError = class extends Error {
	code = "VALIDATION";
};
/** 目标不存在。 */
var StoreNotFoundError = class extends Error {
	code = "SESSION_NOT_FOUND";
};
const DEFAULT_PORTS = {
	ssh: 22,
	telnet: 23
};
/** 校验一条完整配置；有问题直接抛，消息只描述字段不描述值。 */
function validate(cfg) {
	const fail = (message) => {
		throw new StoreValidationError(message);
	};
	if (typeof cfg.label !== "string" || cfg.label.trim().length === 0) fail("名称不能为空");
	if (cfg.protocol !== "ssh" && cfg.protocol !== "telnet") fail("协议必须是 ssh 或 telnet");
	if (typeof cfg.host !== "string" || cfg.host.trim().length === 0) fail("IP 地址不能为空");
	if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) fail("端口必须是 1–65535 的整数");
	if (cfg.protocol === "ssh") {
		if (typeof cfg.username !== "string" || cfg.username.trim().length === 0) fail("SSH 登录需要用户名");
		if (cfg.auth === void 0) fail("SSH 需要认证方式（密码或密钥）");
		if (cfg.auth.kind === "password" && cfg.auth.password.length === 0) fail("选择了密码认证时密码不能为空");
		if (cfg.auth.kind === "key" && cfg.auth.privateKey.trim().length === 0) fail("选择了密钥认证时私钥不能为空");
	}
	if (cfg.promptPattern !== void 0) try {
		new RegExp(cfg.promptPattern);
	} catch {
		fail("提示符正则不合法");
	}
	if (cfg.quietMs !== void 0 && (cfg.quietMs < WAIT_LIMITS.quietMs.min || cfg.quietMs > WAIT_LIMITS.quietMs.max)) fail(`静默期必须在 ${WAIT_LIMITS.quietMs.min}–${WAIT_LIMITS.quietMs.max} 毫秒之间`);
	if (cfg.timeoutMs !== void 0 && (cfg.timeoutMs < WAIT_LIMITS.timeoutMs.min || cfg.timeoutMs > WAIT_LIMITS.timeoutMs.max)) fail(`超时必须在 ${WAIT_LIMITS.timeoutMs.min}–${WAIT_LIMITS.timeoutMs.max} 毫秒之间`);
	if (cfg.backspaceByte !== void 0 && cfg.backspaceByte !== 8 && cfg.backspaceByte !== 127) fail("退格字节只能是 8（^H）或 127（DEL）");
	if (cfg.deleteByte !== void 0 && cfg.deleteByte !== 8 && cfg.deleteByte !== 127) fail("删除字节只能是 8（^H）或 127（DEL）");
	if (cfg.telnetMode !== void 0 && !TELNET_MODE_INPUTS.has(cfg.telnetMode)) fail("Telnet 模式无效（只能是 passive/active/raw）");
	if (cfg.log !== void 0) {
		if (typeof cfg.log.enabled !== "boolean" || typeof cfg.log.timestamp !== "boolean" || typeof cfg.log.stripAnsi !== "boolean") fail("日志配置无效");
		if (cfg.log.directory !== void 0 && (typeof cfg.log.directory !== "string" || cfg.log.directory.trim().length === 0)) fail("日志目录无效");
	}
}
/** 连接清单的存取。一个实例对应一个落盘文件。 */
var ConnectionStore = class {
	filePath;
	connections = /* @__PURE__ */ new Map();
	loaded = false;
	loadPromise;
	constructor(filePath) {
		this.filePath = filePath;
	}
	/** 读取落盘文件；不存在则为空清单。 */
	async load() {
		let raw;
		try {
			raw = await promises.readFile(this.filePath, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") {
				this.loaded = true;
				return;
			}
			throw error;
		}
		const parsed = JSON.parse(raw);
		this.connections.clear();
		for (const cfg of parsed.connections ?? []) {
			if (cfg.favorited === void 0) cfg.favorited = true;
			const telnetMode = normalizeTelnetMode$1(cfg.telnetMode);
			if (telnetMode === void 0) delete cfg.telnetMode;
			else cfg.telnetMode = telnetMode;
			validate(cfg);
			this.connections.set(cfg.id, cfg);
		}
		this.loaded = true;
	}
	list() {
		return [...this.connections.values()];
	}
	/** 懒加载：确保已读盘（幂等，首次调用触发）。 */
	async ensureLoaded() {
		this.loadPromise ??= this.load();
		await this.loadPromise;
	}
	get(id) {
		return this.connections.get(id);
	}
	async create(input) {
		const cfg = {
			...input,
			id: randomUUID(),
			port: input.port ?? DEFAULT_PORTS[input.protocol],
			favorited: input.favorited ?? true
		};
		validate(cfg);
		const telnetMode = normalizeTelnetMode$1(cfg.telnetMode);
		if (telnetMode === void 0) delete cfg.telnetMode;
		else cfg.telnetMode = telnetMode;
		this.connections.set(cfg.id, cfg);
		await this.persist();
		return cfg;
	}
	async update(id, patch) {
		const existing = this.connections.get(id);
		if (existing === void 0) throw new StoreNotFoundError(`连接不存在: ${id}`);
		const merged = {
			...existing,
			...patch,
			id: existing.id,
			port: patch.port ?? existing.port,
			protocol: patch.protocol ?? existing.protocol
		};
		validate(merged);
		const telnetMode = normalizeTelnetMode$1(merged.telnetMode);
		if (telnetMode === void 0) delete merged.telnetMode;
		else merged.telnetMode = telnetMode;
		this.connections.set(id, merged);
		await this.persist();
		return merged;
	}
	async remove(id) {
		if (!this.connections.delete(id)) throw new StoreNotFoundError(`连接不存在: ${id}`);
		await this.persist();
	}
	async persist() {
		await promises.mkdir(dirname(this.filePath), { recursive: true });
		const payload = JSON.stringify({
			version: 1,
			connections: [...this.connections.values()]
		}, null, 2);
		await promises.writeFile(this.filePath, payload, "utf8");
		try {
			await promises.chmod(this.filePath, 384);
		} catch {}
	}
};
//#endregion
//#region src/ambiguity.ts
/** 注册歧义处理 system prompt 段落。 */
function registerAmbiguityHandling(ctx, sessions) {
	ctx.systemPrompt.section({
		name: "term-manager:ambiguity",
		order: 108,
		text: () => {
			const openSessions = sessions.list().filter((s) => s.status === "open");
			return `# 终端操作歧义处理

${openSessions.length === 0 ? "当前没有活跃的远程终端会话。" : `当前有 ${openSessions.length} 个活跃会话：\n` + openSessions.map((s) => `- [${s.sessionId}] ${s.label} (${s.protocol} ${s.target})`).join("\n")}

规则：
1. 用户的请求可能涉及本地文件系统或远程终端——存在歧义时必须先问用户，不要臆测、不要假设。
2. 用户明确提到某个会话的 label 或 target（如"路由器A"、"192.168.1.1"）→ 用 tm_send 直接操作该会话。
3. 用户说"所有服务器"/"每台设备"/"全部检查" → 用 tm_send_all 广播。
4. 用户说"那台服务器"但有多个活跃会话 → 列出会话选项让用户选择。
5. 不要假设用户想操作远程终端——用户可能在说本地文件系统。
6. 即使用户只有 1 个远程会话，当指令存在本地/远程歧义时，也要问。

示例：
- "看看文件夹有什么" → 问用户：看本地文件系统？还是某个远程会话？
- "在路由器A上执行 show ip route" → 直接 tm_send 到路由器A 对应的会话
- "检查所有服务器的状态" → tm_send_all 广播
- "在那台交换机上看看"（但有两台交换机）→ 列出两台让用户选`;
		}
	});
}
//#endregion
//#region src/config.ts
/**
* 插件配置（Config schema）—— 用户在 cordis.yml 的 `config:` 下覆盖，缺省值写在 schema 里。
*
* 约定（DSH docs/user/develop/basic/config）：导出同名的 `Config` 类型 + Schemastery schema，
* `apply(ctx, config)` 收到的是校验并填好默认值的对象。
* @module dsh-terminal-manager/config
*/
const Config = Schema.object({ workspaceRoot: Schema.string().default("").description("本地文件面板默认根目录（留空 = DSH 进程当前目录）") });
/** 把（可能缺省的）配置解析成完整对象：空 workspaceRoot 落到当前目录。 */
function resolveConfig(input, cwd = () => process.cwd()) {
	const root = input?.workspaceRoot?.trim() ?? "";
	return { workspaceRoot: root.length > 0 ? root : cwd() };
}
//#endregion
//#region src/ext/port-log/app-logger.ts
const LEVEL_RANK$1 = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};
const SENSITIVE_KEY$1 = /^(password|privatekey|passphrase|authorization|token|secret|credential)$/i;
const MAX_LINE_BYTES$1 = 16384;
function sanitize$1(value, seen = /* @__PURE__ */ new WeakSet()) {
	if (value === null || typeof value !== "object") {
		if (typeof value === "string") return value.replace(/[\r\n]+/g, " ");
		return value;
	}
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => sanitize$1(item, seen));
	const result = {};
	for (const [key, item] of Object.entries(value)) result[key] = SENSITIVE_KEY$1.test(key) ? "[REDACTED]" : sanitize$1(item, seen);
	return result;
}
var AppLogger$1 = class {
	directory;
	currentFile;
	maxBytes;
	maxFiles;
	now;
	level;
	size = 0;
	ready;
	queue = Promise.resolve();
	closed = false;
	lastError;
	constructor(directory, options = {}) {
		this.directory = directory;
		this.currentFile = join(directory, "app.log");
		this.level = options.level ?? "info";
		this.maxBytes = options.maxBytes ?? 5242880;
		this.maxFiles = options.maxFiles ?? 5;
		this.now = options.now ?? (() => /* @__PURE__ */ new Date());
	}
	setLevel(level) {
		this.level = level;
	}
	log(level, event, fields = {}) {
		if (this.closed || LEVEL_RANK$1[level] < LEVEL_RANK$1[this.level]) return this.queue;
		this.queue = this.queue.then(async () => {
			try {
				await this.ensureReady();
				let line = `${this.now().toISOString()} ${level.toUpperCase()} ${event} ${JSON.stringify(sanitize$1(fields))}\n`;
				if (Buffer.byteLength(line) > MAX_LINE_BYTES$1) line = `${this.now().toISOString()} ${level.toUpperCase()} ${event} {"truncated":true}\n`;
				const bytes = Buffer.byteLength(line);
				if (this.size > 0 && this.size + bytes > this.maxBytes) await this.rotate();
				const file = await open(this.currentFile, "a", 384);
				try {
					await file.writeFile(line, "utf8");
					await file.sync();
				} finally {
					await file.close();
				}
				this.size += bytes;
			} catch {
				this.lastError = "应用日志写入失败";
				console.error("[term-manager:port-log] application log write failed");
			}
		});
		return this.queue;
	}
	async status() {
		await this.queue;
		await this.ensureReady();
		const names = (await readdir(this.directory)).filter((name) => /^app\.log(?:\.\d+)?$/.test(name)).sort();
		const files = await Promise.all(names.map(async (name) => {
			const path = join(this.directory, name);
			return {
				path,
				bytes: (await stat(path)).size
			};
		}));
		return {
			level: this.level,
			directory: this.directory,
			currentFile: this.currentFile,
			files,
			...this.lastError === void 0 ? {} : { lastError: this.lastError }
		};
	}
	async close() {
		this.closed = true;
		await this.queue;
	}
	async ensureReady() {
		this.ready ??= (async () => {
			await mkdir(this.directory, {
				recursive: true,
				mode: 448
			});
			try {
				this.size = (await stat(this.currentFile)).size;
			} catch {
				this.size = 0;
			}
		})();
		await this.ready;
	}
	async rotate() {
		const oldest = join(this.directory, `app.log.${this.maxFiles - 1}`);
		await rm(oldest, { force: true });
		for (let index = this.maxFiles - 2; index >= 1; index -= 1) try {
			await rename(join(this.directory, `app.log.${index}`), join(this.directory, `app.log.${index + 1}`));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		try {
			await rename(this.currentFile, join(this.directory, "app.log.1"));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		this.size = 0;
	}
};
//#endregion
//#region src/ext/port-log/errors.ts
var PortLogError = class extends Error {
	code;
	details;
	constructor(code, message, details = {}) {
		super(message);
		this.code = code;
		this.details = details;
		this.name = "PortLogError";
	}
};
function safeError(error) {
	if (error instanceof PortLogError) return {
		code: error.code,
		message: error.message
	};
	return {
		code: "IO_ERROR",
		message: "操作失败，请查看应用日志"
	};
}
//#endregion
//#region src/ext/port-log/network.ts
function validateLocalAddress(value) {
	const address = value.trim();
	if (isIP(address) === 0) throw new PortLogError("ADDRESS_INVALID", "监听地址必须是 IPv4 或 IPv6 地址");
	return address;
}
function validateTarget(value) {
	const target = value.trim();
	if (target.length === 0 || target.length > 253) throw new PortLogError("ADDRESS_INVALID", "目标地址无效");
	if (isIP(target) !== 0) return target;
	if (target.split(".").some((label) => label.length === 0 || label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) throw new PortLogError("ADDRESS_INVALID", "目标地址无效");
	return target.toLowerCase();
}
function validatePort(value, field) {
	if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) throw new PortLogError("VALIDATION", `${field} 必须是 1–65535 的整数`);
	return Number(value);
}
function localAddresses(interfaces = networkInterfaces()) {
	const values = /* @__PURE__ */ new Set(["0.0.0.0", "::"]);
	for (const entries of Object.values(interfaces)) for (const entry of entries ?? []) values.add(entry.address);
	return [...values].sort((left, right) => {
		const fixed = (value) => value === "0.0.0.0" ? 0 : value === "::" ? 1 : 2;
		return fixed(left) - fixed(right) || left.localeCompare(right);
	});
}
//#endregion
//#region src/ext/port-log/mapping-store.ts
function validateMappingInput(input) {
	if (input.protocol !== "tcp" && input.protocol !== "udp") throw new PortLogError("VALIDATION", "协议必须是 tcp 或 udp");
	if (typeof input.autoStart !== "boolean") throw new PortLogError("VALIDATION", "autoStart 必须是布尔值");
	return {
		protocol: input.protocol,
		localAddr: validateLocalAddress(input.localAddr),
		localPort: validatePort(input.localPort, "本地端口"),
		redirectAddr: validateTarget(input.redirectAddr),
		redirectPort: validatePort(input.redirectPort, "目标端口"),
		autoStart: input.autoStart
	};
}
function listenerKey(config) {
	return `${config.protocol}|${config.localAddr}|${config.localPort}`;
}
var MappingStore = class {
	path;
	mappings = [];
	loaded = false;
	constructor(path) {
		this.path = path;
	}
	async ensureLoaded() {
		if (this.loaded) return;
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			if (parsed.version !== 1 || !Array.isArray(parsed.mappings)) throw new Error("invalid version");
			const seenIds = /* @__PURE__ */ new Set();
			const seenListeners = /* @__PURE__ */ new Set();
			this.mappings = parsed.mappings.map((item) => {
				if (typeof item.id !== "string" || item.id.length === 0 || seenIds.has(item.id)) throw new Error("invalid id");
				const validated = {
					id: item.id,
					...validateMappingInput(item)
				};
				const key = listenerKey(validated);
				if (seenListeners.has(key)) throw new Error("duplicate listener");
				seenIds.add(item.id);
				seenListeners.add(key);
				return validated;
			});
		} catch (error) {
			if (error.code !== "ENOENT") throw new PortLogError("IO_ERROR", "端口映射配置无法读取");
			this.mappings = [];
		}
		this.loaded = true;
	}
	list() {
		this.assertLoaded();
		return this.mappings.map((item) => ({ ...item }));
	}
	async create(input) {
		this.assertLoaded();
		const item = {
			id: randomUUID(),
			...validateMappingInput(input)
		};
		this.assertUnique(item);
		this.mappings.push(item);
		await this.persistOrRollback(() => this.mappings.pop());
		return { ...item };
	}
	async update(id, patch) {
		this.assertLoaded();
		const index = this.mappings.findIndex((item) => item.id === id);
		if (index < 0) throw new PortLogError("MAPPING_NOT_FOUND", "端口映射不存在");
		const previous = this.mappings[index];
		const next = {
			id,
			...validateMappingInput({
				...previous,
				...patch
			})
		};
		this.assertUnique(next, id);
		this.mappings[index] = next;
		await this.persistOrRollback(() => {
			this.mappings[index] = previous;
		});
		return { ...next };
	}
	async remove(id) {
		this.assertLoaded();
		const index = this.mappings.findIndex((item) => item.id === id);
		if (index < 0) throw new PortLogError("MAPPING_NOT_FOUND", "端口映射不存在");
		const [removed] = this.mappings.splice(index, 1);
		await this.persistOrRollback(() => {
			this.mappings.splice(index, 0, removed);
		});
	}
	async merge(inputs) {
		this.assertLoaded();
		const additions = inputs.map((input) => ({
			id: randomUUID(),
			...validateMappingInput(input)
		}));
		const keys = new Set(this.mappings.map(listenerKey));
		for (const item of additions) {
			const key = listenerKey(item);
			if (keys.has(key)) throw new PortLogError("VALIDATION", "监听地址、端口和协议重复");
			keys.add(key);
		}
		this.mappings.push(...additions);
		await this.persistOrRollback(() => {
			this.mappings.splice(this.mappings.length - additions.length, additions.length);
		});
		return additions.map((item) => ({ ...item }));
	}
	assertLoaded() {
		if (!this.loaded) throw new PortLogError("IO_ERROR", "端口映射配置尚未加载");
	}
	assertUnique(config, excludingId) {
		const key = listenerKey(config);
		if (this.mappings.some((item) => item.id !== excludingId && listenerKey(item) === key)) throw new PortLogError("VALIDATION", "监听地址、端口和协议重复");
	}
	async persistOrRollback(rollback) {
		try {
			await this.persist();
		} catch {
			rollback();
			throw new PortLogError("IO_ERROR", "端口映射配置无法保存");
		}
	}
	async persist() {
		const directory = dirname(this.path);
		await mkdir(directory, {
			recursive: true,
			mode: 448
		});
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const file = await open(temporary, "wx", 384);
			try {
				await file.writeFile(JSON.stringify({
					version: 1,
					mappings: this.mappings
				}, null, 2), "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, this.path);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => void 0);
			throw error;
		}
	}
};
//#endregion
//#region src/ext/port-log/tcp-forwarder.ts
function networkError(error) {
	const code = error.code;
	if (code === "EADDRINUSE") return new PortLogError("PORT_IN_USE", "监听端口已被占用");
	if (code === "EADDRNOTAVAIL" || code === "EINVAL") return new PortLogError("ADDRESS_INVALID", "监听地址不可用");
	return new PortLogError("IO_ERROR", "TCP 映射启动失败");
}
var TcpForwarder = class {
	config;
	onStats;
	connectTimeoutMs;
	drainTimeoutMs;
	server;
	pairs = /* @__PURE__ */ new Set();
	stats = {
		activeCount: 0,
		bytesClientToTarget: 0,
		bytesTargetToClient: 0
	};
	stopping = false;
	constructor(config, onStats, connectTimeoutMs = 3e3, drainTimeoutMs = 2e3) {
		this.config = config;
		this.onStats = onStats;
		this.connectTimeoutMs = connectTimeoutMs;
		this.drainTimeoutMs = drainTimeoutMs;
	}
	async start() {
		if (this.server !== void 0) return;
		this.stopping = false;
		const server = createServer({ allowHalfOpen: true }, (client) => this.accept(client));
		this.server = server;
		await new Promise((resolve, reject) => {
			const onError = (error) => {
				server.off("listening", onListening);
				this.server = void 0;
				reject(networkError(error));
			};
			const onListening = () => {
				server.off("error", onError);
				server.on("error", (error) => this.reportError(networkError(error).message));
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.config.localPort, this.config.localAddr);
		});
	}
	async stop() {
		if (this.server === void 0 && this.pairs.size === 0) return;
		this.stopping = true;
		const server = this.server;
		this.server = void 0;
		let serverClosed = Promise.resolve();
		if (server !== void 0) serverClosed = new Promise((resolve) => server.close(() => resolve()));
		if (this.pairs.size > 0) await new Promise((resolve) => {
			const timer = setTimeout(resolve, this.drainTimeoutMs);
			timer.unref();
			const poll = () => {
				if (this.pairs.size === 0) {
					clearTimeout(timer);
					resolve();
				} else setTimeout(poll, 10).unref();
			};
			poll();
		});
		for (const pair of this.pairs) {
			pair.client.destroy();
			pair.target.destroy();
		}
		this.pairs.clear();
		await serverClosed;
		this.stats.activeCount = 0;
		this.emitStats();
	}
	accept(client) {
		if (this.stopping) {
			client.destroy();
			return;
		}
		client.pause();
		const target = createConnection({
			host: this.config.redirectAddr,
			port: this.config.redirectPort,
			allowHalfOpen: true
		});
		const pair = {
			client,
			target
		};
		let connected = false;
		const timeout = setTimeout(() => {
			if (!connected) {
				this.reportError("目标连接超时");
				client.destroy();
				target.destroy();
			}
		}, this.connectTimeoutMs);
		timeout.unref();
		target.once("connect", () => {
			connected = true;
			clearTimeout(timeout);
			this.pairs.add(pair);
			this.stats.activeCount = this.pairs.size;
			this.emitStats();
			client.on("data", (chunk) => {
				this.stats.bytesClientToTarget += chunk.length;
				this.emitStats();
			});
			target.on("data", (chunk) => {
				this.stats.bytesTargetToClient += chunk.length;
				this.emitStats();
			});
			client.pipe(target);
			target.pipe(client);
			client.resume();
		});
		const fail = () => {
			clearTimeout(timeout);
			if (!connected) this.reportError("目标连接失败");
			client.destroy();
			target.destroy();
		};
		target.on("error", fail);
		client.on("error", () => {
			target.destroy();
		});
		let closed = 0;
		const onClose = () => {
			closed += 1;
			if (closed < 2) return;
			if (this.pairs.delete(pair)) {
				this.stats.activeCount = this.pairs.size;
				this.emitStats();
			}
		};
		client.once("close", onClose);
		target.once("close", onClose);
	}
	reportError(message) {
		this.stats.lastError = message;
		this.emitStats();
	}
	emitStats() {
		this.onStats({ ...this.stats });
	}
};
//#endregion
//#region src/ext/port-log/udp-forwarder.ts
function peerKey(source) {
	return `${source.family}|${source.address}|${source.port}`;
}
var UdpForwarder = class {
	config;
	onStats;
	idleMs;
	sweepMs;
	maxPeers;
	listener;
	peers = /* @__PURE__ */ new Map();
	sweep;
	target;
	stats = {
		activeCount: 0,
		bytesClientToTarget: 0,
		bytesTargetToClient: 0
	};
	constructor(config, onStats, idleMs = 6e4, sweepMs = 1e4, maxPeers = 1024) {
		this.config = config;
		this.onStats = onStats;
		this.idleMs = idleMs;
		this.sweepMs = sweepMs;
		this.maxPeers = maxPeers;
	}
	async start() {
		if (this.listener !== void 0) return;
		try {
			const resolved = await lookup(this.config.redirectAddr, { family: 0 });
			this.target = {
				address: resolved.address,
				family: resolved.family
			};
			const family = isIP(this.config.localAddr) === 6 ? "udp6" : "udp4";
			const listener = createSocket(family);
			this.listener = listener;
			listener.on("message", (message, source) => this.forward(message, source));
			listener.on("error", () => this.reportError("UDP 映射运行错误"));
			await new Promise((resolve, reject) => {
				listener.once("listening", resolve);
				listener.once("error", reject);
				listener.bind(this.config.localPort, this.config.localAddr);
			});
			this.sweep = setInterval(() => this.sweepIdle(), this.sweepMs);
			this.sweep.unref();
		} catch (error) {
			await this.stop();
			const code = error.code;
			if (code === "EADDRINUSE") throw new PortLogError("PORT_IN_USE", "监听端口已被占用");
			if (code === "ENOTFOUND" || code === "EAI_AGAIN") throw new PortLogError("TARGET_UNREACHABLE", "目标地址无法解析");
			throw error instanceof PortLogError ? error : new PortLogError("IO_ERROR", "UDP 映射启动失败");
		}
	}
	async stop() {
		if (this.sweep !== void 0) clearInterval(this.sweep);
		this.sweep = void 0;
		for (const peer of this.peers.values()) peer.socket.close();
		this.peers.clear();
		this.stats.activeCount = 0;
		const listener = this.listener;
		this.listener = void 0;
		if (listener !== void 0) await new Promise((resolve) => {
			try {
				listener.close(() => resolve());
			} catch {
				resolve();
			}
		});
		this.emitStats();
	}
	forward(message, source) {
		const target = this.target;
		const listener = this.listener;
		if (target === void 0 || listener === void 0) return;
		const key = peerKey(source);
		let peer = this.peers.get(key);
		if (peer === void 0) {
			if (this.peers.size >= this.maxPeers) {
				this.reportError("UDP 来源端点数量已达上限");
				return;
			}
			const socket = createSocket(target.family === 6 ? "udp6" : "udp4");
			peer = {
				socket,
				source,
				lastSeen: Date.now(),
				pendingPackets: 0,
				pendingBytes: 0
			};
			this.peers.set(key, peer);
			socket.on("message", (reply) => {
				const currentListener = this.listener;
				if (currentListener === void 0) return;
				currentListener.send(reply, peer.source.port, peer.source.address);
				this.stats.bytesTargetToClient += reply.length;
				this.emitStats();
			});
			socket.on("error", () => {
				this.removePeer(key);
				this.reportError("UDP 目标通信失败");
			});
			this.stats.activeCount = this.peers.size;
		}
		peer.lastSeen = Date.now();
		if (peer.pendingPackets >= 64 || peer.pendingBytes + message.length > 1048576) {
			this.reportError("UDP 来源端点待发送数据已达上限");
			return;
		}
		peer.pendingPackets += 1;
		peer.pendingBytes += message.length;
		peer.socket.send(message, this.config.redirectPort, target.address, (error) => {
			peer.pendingPackets -= 1;
			peer.pendingBytes -= message.length;
			if (error !== null) {
				this.removePeer(key);
				this.reportError("UDP 目标通信失败");
			}
		});
		this.stats.bytesClientToTarget += message.length;
		this.emitStats();
	}
	sweepIdle() {
		const deadline = Date.now() - this.idleMs;
		for (const [key, peer] of this.peers) if (peer.lastSeen <= deadline) this.removePeer(key);
	}
	removePeer(key) {
		const peer = this.peers.get(key);
		if (peer === void 0) return;
		this.peers.delete(key);
		try {
			peer.socket.close();
		} catch {}
		this.stats.activeCount = this.peers.size;
		this.emitStats();
	}
	reportError(message) {
		this.stats.lastError = message;
		this.emitStats();
	}
	emitStats() {
		this.onStats({ ...this.stats });
	}
};
//#endregion
//#region src/ext/port-log/mapping-manager.ts
var MappingManager = class {
	store;
	logger;
	events;
	runtimes = /* @__PURE__ */ new Map();
	snapshots = /* @__PURE__ */ new Map();
	operations = /* @__PURE__ */ new Map();
	notifications = /* @__PURE__ */ new Map();
	closing = false;
	constructor(store, logger, events) {
		this.store = store;
		this.logger = logger;
		this.events = events;
	}
	async initialize() {
		await this.store.ensureLoaded();
		for (const config of this.store.list()) this.snapshots.set(config.id, this.initialSnapshot(config));
	}
	list() {
		return this.store.list().map((config) => ({ ...this.snapshots.get(config.id) ?? this.initialSnapshot(config) }));
	}
	async create(input) {
		this.assertOpen();
		const config = await this.store.create(input);
		const snapshot = this.initialSnapshot(config);
		this.snapshots.set(config.id, snapshot);
		this.publish(snapshot);
		return { ...snapshot };
	}
	async merge(inputs) {
		this.assertOpen();
		return (await this.store.merge(inputs)).map((config) => {
			const snapshot = this.initialSnapshot(config);
			this.snapshots.set(config.id, snapshot);
			this.publish(snapshot);
			return { ...snapshot };
		});
	}
	update(id, patch) {
		return this.enqueue(id, async () => {
			this.assertOpen();
			const wasRunning = this.runtimes.has(id);
			if (wasRunning) await this.stopRuntime(id);
			const config = await this.store.update(id, patch);
			const snapshot = this.initialSnapshot(config);
			this.snapshots.set(id, snapshot);
			if (wasRunning) await this.startRuntime(config);
			else this.publish(snapshot);
			return { ...this.snapshots.get(id) };
		});
	}
	remove(id) {
		return this.enqueue(id, async () => {
			this.assertOpen();
			await this.stopRuntime(id);
			await this.store.remove(id);
			this.snapshots.delete(id);
			this.events.publish({
				type: "mapping-removed",
				data: { id }
			});
		});
	}
	start(id) {
		return this.enqueue(id, async () => {
			this.assertOpen();
			const existing = this.snapshots.get(id);
			if (existing === void 0) throw new PortLogError("MAPPING_NOT_FOUND", "端口映射不存在");
			if (this.runtimes.has(id)) return { ...existing };
			const config = this.store.list().find((item) => item.id === id);
			if (config === void 0) throw new PortLogError("MAPPING_NOT_FOUND", "端口映射不存在");
			await this.startRuntime(config);
			return { ...this.snapshots.get(id) };
		});
	}
	stop(id) {
		return this.enqueue(id, async () => {
			if (!this.snapshots.has(id)) throw new PortLogError("MAPPING_NOT_FOUND", "端口映射不存在");
			await this.stopRuntime(id);
			return { ...this.snapshots.get(id) };
		});
	}
	async autoStart() {
		const configs = this.store.list().filter((item) => item.autoStart);
		await Promise.allSettled(configs.map((item) => this.start(item.id)));
	}
	async stopAll() {
		this.closing = true;
		await Promise.allSettled([...this.runtimes.keys()].map((id) => this.enqueue(id, () => this.stopRuntime(id))));
		for (const timer of this.notifications.values()) clearTimeout(timer);
		this.notifications.clear();
	}
	async startRuntime(config) {
		this.setState(config.id, "starting");
		const onStats = (stats) => this.updateStats(config.id, stats);
		const runtime = config.protocol === "tcp" ? new TcpForwarder(config, onStats) : new UdpForwarder(config, onStats);
		try {
			await runtime.start();
			this.runtimes.set(config.id, runtime);
			this.setState(config.id, "running");
			await this.logger.log("info", "mapping.started", {
				id: config.id,
				protocol: config.protocol,
				localAddr: config.localAddr,
				localPort: config.localPort
			});
		} catch (error) {
			const safe = safeError(error);
			this.updateStats(config.id, {
				activeCount: 0,
				bytesClientToTarget: 0,
				bytesTargetToClient: 0,
				lastError: safe.message
			});
			this.setState(config.id, "error");
			await this.logger.log("error", "mapping.start_failed", {
				id: config.id,
				code: safe.code
			});
			throw error;
		}
	}
	async stopRuntime(id) {
		if (this.snapshots.get(id) === void 0) return;
		const runtime = this.runtimes.get(id);
		if (runtime === void 0) {
			this.setState(id, "stopped");
			return;
		}
		this.setState(id, "stopping");
		try {
			await runtime.stop();
		} finally {
			this.runtimes.delete(id);
			this.setState(id, "stopped");
			await this.logger.log("info", "mapping.stopped", { id });
		}
	}
	updateStats(id, stats) {
		const snapshot = this.snapshots.get(id);
		if (snapshot === void 0) return;
		Object.assign(snapshot, stats);
		if (stats.lastError !== void 0) {
			this.publish(snapshot);
			return;
		}
		if (this.notifications.has(id)) return;
		const timer = setTimeout(() => {
			this.notifications.delete(id);
			const latest = this.snapshots.get(id);
			if (latest !== void 0) this.publish(latest);
		}, 500);
		timer.unref();
		this.notifications.set(id, timer);
	}
	setState(id, state) {
		const snapshot = this.snapshots.get(id);
		if (snapshot === void 0) return;
		snapshot.state = state;
		this.publish(snapshot);
	}
	publish(snapshot) {
		this.events.publish({
			type: "mapping-status",
			data: { ...snapshot }
		});
	}
	initialSnapshot(config) {
		return {
			...config,
			state: "stopped",
			activeCount: 0,
			bytesClientToTarget: 0,
			bytesTargetToClient: 0
		};
	}
	enqueue(id, operation) {
		const current = (this.operations.get(id) ?? Promise.resolve()).catch(() => void 0).then(operation);
		this.operations.set(id, current);
		current.finally(() => {
			if (this.operations.get(id) === current) this.operations.delete(id);
		}).catch(() => void 0);
		return current;
	}
	assertOpen() {
		if (this.closing) throw new PortLogError("MAPPING_STATE", "扩展正在关闭");
	}
};
//#endregion
//#region src/ext/port-log/csv.ts
const MAX_CSV_BYTES = 1048576;
const MAX_CSV_ROWS = 1e3;
function parseRows(text) {
	const rows = [];
	let row = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === "\"" && text[index + 1] === "\"") {
				field += "\"";
				index += 1;
			} else if (char === "\"") quoted = false;
			else field += char;
		} else if (char === "\"" && field.length === 0) quoted = true;
		else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[index + 1] === "\n") index += 1;
			row.push(field);
			if (row.some((value) => value.trim().length > 0)) rows.push(row);
			row = [];
			field = "";
		} else field += char;
	}
	if (quoted) throw new PortLogError("IMPORT_INVALID", "CSV 引号未闭合");
	row.push(field);
	if (row.some((value) => value.trim().length > 0)) rows.push(row);
	return rows;
}
function parseEndpoint(value, line, field) {
	const trimmed = value.trim();
	const ipv6 = /^\[([^\]]+)]:(\d+)$/.exec(trimmed);
	const regular = /^(.+):(\d+)$/.exec(trimmed);
	const match = ipv6 ?? regular;
	if (match === null) throw new PortLogError("IMPORT_INVALID", `第 ${line} 行 ${field} 格式无效`, {
		line,
		field
	});
	return {
		address: match[1],
		port: Number(match[2])
	};
}
function parseBoolean(value, line) {
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1") return true;
	if (normalized === "false" || normalized === "0" || normalized === "") return false;
	throw new PortLogError("IMPORT_INVALID", `第 ${line} 行 autoStart 格式无效`, {
		line,
		field: "autoStart"
	});
}
function parseMappingsCsv(source) {
	const text = Buffer.isBuffer(source) ? source.toString("utf8") : source;
	if (Buffer.byteLength(text) > MAX_CSV_BYTES) throw new PortLogError("IMPORT_INVALID", "CSV 文件不能超过 1 MiB");
	const rows = parseRows(text.replace(/^\uFEFF/, ""));
	if (rows[0]?.[0]?.trim().toLowerCase() === "protocol") rows.shift();
	if (rows.length > MAX_CSV_ROWS) throw new PortLogError("IMPORT_INVALID", "CSV 最多包含 1000 条映射");
	return rows.map((columns, index) => {
		const line = index + 1;
		try {
			let input;
			if (columns.length === 3) {
				const local = parseEndpoint(columns[1], line, "local");
				const redirect = parseEndpoint(columns[2], line, "redirect");
				input = {
					protocol: columns[0].trim().toLowerCase(),
					localAddr: local.address,
					localPort: local.port,
					redirectAddr: redirect.address,
					redirectPort: redirect.port,
					autoStart: false
				};
			} else if (columns.length === 5 || columns.length === 6) input = {
				protocol: columns[0].trim().toLowerCase(),
				localAddr: columns[1].trim(),
				localPort: Number(columns[2]),
				redirectAddr: columns[3].trim(),
				redirectPort: Number(columns[4]),
				autoStart: columns.length === 6 ? parseBoolean(columns[5], line) : false
			};
			else throw new PortLogError("IMPORT_INVALID", `第 ${line} 行字段数必须是 3、5 或 6`, { line });
			return validateMappingInput(input);
		} catch (error) {
			if (error instanceof PortLogError && error.code === "IMPORT_INVALID") throw error;
			throw new PortLogError("IMPORT_INVALID", `第 ${line} 行配置无效`, { line });
		}
	});
}
function quote(value) {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}
function exportMappingsCsv(mappings) {
	return ["protocol,localAddr,localPort,redirectAddr,redirectPort,autoStart", ...mappings.map((item) => [
		item.protocol,
		item.localAddr,
		String(item.localPort),
		item.redirectAddr,
		String(item.redirectPort),
		String(item.autoStart)
	].map(quote).join(","))].join("\r\n") + "\r\n";
}
//#endregion
//#region src/ext/port-log/known-folders.ts
/**
* 「浏览」目录选择器用的本机目录概览：
* - 快速访问：桌面 / 下载 / 文档 / 图片 / 音乐 / 视频（带 OneDrive 重定向回退，目录不存在则去掉）；
* - 此电脑：Windows 枚举磁盘盘符；POSIX 只给根目录 /。
* 平台相关的探测集中在这里，方便测试注入假平台 / 假 home。
* @module dsh-terminal-manager/ext/port-log/known-folders
*/
const QUICK_DEFS = [
	{
		id: "desktop",
		label: "桌面",
		dirs: ["Desktop", "OneDrive/Desktop"]
	},
	{
		id: "downloads",
		label: "下载",
		dirs: ["Downloads"]
	},
	{
		id: "documents",
		label: "文档",
		dirs: ["Documents", "OneDrive/Documents"]
	},
	{
		id: "pictures",
		label: "图片",
		dirs: ["Pictures", "OneDrive/Pictures"]
	},
	{
		id: "music",
		label: "音乐",
		dirs: ["Music"]
	},
	{
		id: "videos",
		label: "视频",
		dirs: ["Videos"]
	}
];
async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
async function resolveQuickFolders(home) {
	const result = [];
	for (const def of QUICK_DEFS) for (const rel of def.dirs) {
		const path = join(home, rel);
		if (await exists(path)) {
			result.push({
				id: def.id,
				label: def.label,
				path
			});
			break;
		}
	}
	return result;
}
async function resolveDrives(platform) {
	if (platform === "win32") {
		const drives = [];
		for (let code = 65; code <= 90; code += 1) {
			const letter = String.fromCharCode(code);
			if (await exists(`${letter}:/`)) drives.push({
				label: `${letter}:`,
				path: `${letter}:/`
			});
		}
		return drives;
	}
	return [{
		label: "/",
		path: "/"
	}];
}
/** 只扫描实际存在的目录；任何盘符 / 目录都扫不到时返回空数组。 */
async function resolveKnownFolders(options = {}) {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const [quick, drives] = await Promise.all([resolveQuickFolders(home), resolveDrives(platform)]);
	return {
		home,
		quick,
		drives
	};
}
//#endregion
//#region src/ext/port-log/router.ts
const PREFIX = "/term-manager/ext/port-log";
/** /api 下 port-log RPC 的端点前缀（不含 `/api/`）。 */
const PORT_LOG_ENDPOINT_PREFIX = "port-log/";
/** port-log 控制面方法全集（每个方法注册一条 /api 下的精确 Fetch 路由）。 */
const PORT_LOG_METHODS = [
	"appLogs.status",
	"network.localAddresses",
	"sessions.list",
	"mappings.list",
	"mappings.create",
	"mappings.update",
	"mappings.remove",
	"mappings.importCsv",
	"mappings.exportCsv",
	"mappings.start",
	"mappings.stop",
	"shares.list",
	"shares.start",
	"shares.stop",
	"sessionLogs.list",
	"sessionLogs.defaultDirectory",
	"sessionLogs.start",
	"sessionLogs.update",
	"sessionLogs.stop",
	"sessionLogs.pickDirectory",
	"sessionLogs.listDir",
	"sessionLogs.knownFolders"
];
/** SSE 流路由（保留非 /api 前缀，DSH Connection 仍会做认证）。 */
const PORT_LOG_EVENTS_PATH = `${PREFIX}/events`;
function ok$1(value) {
	return {
		ok: true,
		value
	};
}
function requireString(payload, key) {
	const value = payload[key];
	if (typeof value !== "string" || value.length === 0) throw new PortLogError("VALIDATION", `${key} 无效`);
	return value;
}
async function dispatchPortLog(endpoint, payload, deps, signal = new AbortController().signal) {
	try {
		await deps.ready;
		switch (endpoint) {
			case "appLogs.status": return ok$1(await deps.logger.status());
			case "network.localAddresses": return ok$1(localAddresses());
			case "mappings.list": return ok$1(deps.mappings?.list() ?? deps.store.list());
			case "mappings.create": {
				const created = deps.mappings === void 0 ? await deps.store.create(payload) : await deps.mappings.create(payload);
				deps.events.publish({
					type: "mapping-status",
					data: created
				});
				await deps.logger.log("info", "mapping.created", {
					id: created.id,
					protocol: created.protocol,
					localAddr: created.localAddr,
					localPort: created.localPort
				});
				return ok$1(created);
			}
			case "mappings.update": {
				const id = requireString(payload, "id");
				const patch = payload.patch;
				if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw new PortLogError("VALIDATION", "patch 无效");
				const updated = deps.mappings === void 0 ? await deps.store.update(id, patch) : await deps.mappings.update(id, patch);
				deps.events.publish({
					type: "mapping-status",
					data: updated
				});
				await deps.logger.log("info", "mapping.updated", { id });
				return ok$1(updated);
			}
			case "mappings.remove": {
				const id = requireString(payload, "id");
				if (deps.mappings === void 0) await deps.store.remove(id);
				else await deps.mappings.remove(id);
				deps.events.publish({
					type: "mapping-removed",
					data: { id }
				});
				await deps.logger.log("info", "mapping.removed", { id });
				return ok$1({ id });
			}
			case "mappings.importCsv": {
				const inputs = parseMappingsCsv(requireString(payload, "csv"));
				const created = deps.mappings === void 0 ? await deps.store.merge(inputs) : await deps.mappings.merge(inputs);
				for (const item of created) deps.events.publish({
					type: "mapping-status",
					data: item
				});
				await deps.logger.log("info", "mapping.csv_imported", { count: created.length });
				return ok$1({
					count: created.length,
					mappings: created
				});
			}
			case "mappings.exportCsv": return ok$1({ csv: exportMappingsCsv(deps.mappings?.list() ?? deps.store.list()) });
			case "mappings.start":
				if (deps.mappings === void 0) throw new PortLogError("MAPPING_STATE", "映射运行时尚未就绪");
				return ok$1(await deps.mappings.start(requireString(payload, "id")));
			case "mappings.stop":
				if (deps.mappings === void 0) throw new PortLogError("MAPPING_STATE", "映射运行时尚未就绪");
				return ok$1(await deps.mappings.stop(requireString(payload, "id")));
			case "sessions.list":
				if (deps.sessions === void 0) throw new PortLogError("MAPPING_STATE", "会话服务尚未就绪");
				return ok$1(deps.sessions.list());
			case "shares.list": return ok$1(deps.shares?.list() ?? []);
			case "shares.start":
				if (deps.shares === void 0) throw new PortLogError("MAPPING_STATE", "共享服务尚未就绪");
				return ok$1(await deps.shares.start({
					sessionId: requireString(payload, "sessionId"),
					localAddr: typeof payload.localAddr === "string" ? payload.localAddr : "0.0.0.0",
					sharePort: payload.sharePort,
					maxClients: payload.maxClients === void 0 ? 0 : payload.maxClients,
					welcomeMessage: payload.welcomeMessage === void 0 ? "" : payload.welcomeMessage
				}));
			case "shares.stop": {
				if (deps.shares === void 0) throw new PortLogError("MAPPING_STATE", "共享服务尚未就绪");
				const sessionId = requireString(payload, "sessionId");
				await deps.shares.stop(sessionId);
				return ok$1({ sessionId });
			}
			case "sessionLogs.list": return ok$1(deps.sessionLogs?.list() ?? []);
			case "sessionLogs.defaultDirectory": return ok$1({ directory: deps.sessionLogs?.getDefaultDirectory() ?? "" });
			case "sessionLogs.start": {
				if (deps.sessionLogs === void 0) throw new PortLogError("MAPPING_STATE", "会话日志服务尚未就绪");
				const directory = typeof payload.directory === "string" && payload.directory.trim() !== "" ? payload.directory.trim() : void 0;
				return ok$1(await deps.sessionLogs.start(requireString(payload, "sessionId"), {
					timestamp: payload.timestamp === true,
					stripAnsi: payload.stripAnsi !== false
				}, directory));
			}
			case "sessionLogs.update":
				if (deps.sessionLogs === void 0) throw new PortLogError("MAPPING_STATE", "会话日志服务尚未就绪");
				return ok$1(await deps.sessionLogs.update(requireString(payload, "sessionId"), {
					timestamp: payload.timestamp === true,
					stripAnsi: payload.stripAnsi !== false
				}));
			case "sessionLogs.stop": {
				if (deps.sessionLogs === void 0) throw new PortLogError("MAPPING_STATE", "会话日志服务尚未就绪");
				const sessionId = requireString(payload, "sessionId");
				await deps.sessionLogs.stop(sessionId);
				return ok$1({ sessionId });
			}
			case "sessionLogs.pickDirectory":
				if (!deps.pickDirectory) throw new PortLogError("IO_ERROR", "当前 DSH 未启用系统目录选择器");
				return ok$1({ directory: await deps.pickDirectory(signal) });
			case "sessionLogs.listDir": {
				const raw = typeof payload.path === "string" ? payload.path.trim() : "";
				const dir = raw === "" ? deps.sessionLogs?.getDefaultDirectory() ?? homedir() : resolve(raw);
				try {
					const dirs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b, void 0, { sensitivity: "base" }));
					return ok$1({
						path: dir,
						parent: (sep === "/" ? dir === "/" : /^[A-Za-z]:[\\/]?$/.test(dir)) ? null : resolve(dir, ".."),
						dirs
					});
				} catch {
					throw new PortLogError("IO_ERROR", `无法读取目录：${dir}`);
				}
			}
			case "sessionLogs.knownFolders": return ok$1(await resolveKnownFolders());
			default: throw new PortLogError("VALIDATION", "未知方法");
		}
	} catch (error) {
		return {
			ok: false,
			error: {
				...safeError(error),
				details: error instanceof PortLogError ? error.details : {}
			}
		};
	}
}
/** /api 通道的 port-log RPC handler：endpoint 形如 `port-log/mappings.list`。 */
function createPortLogRpcHandler(deps) {
	return async (endpoint, payload, signal) => {
		return dispatchPortLog(endpoint.startsWith("port-log/") ? endpoint.slice(9) : endpoint, payload ?? {}, deps, signal);
	};
}
/** SSE 事件流（认证由调用方在挂载时经 Connection 完成）。 */
function createPortLogEventsHandler(deps) {
	return (_request, response) => {
		deps.events.subscribe(response);
	};
}
//#endregion
//#region src/ext/port-log/sse.ts
var RuntimeEventHub = class {
	clients = /* @__PURE__ */ new Set();
	closed = false;
	get clientCount() {
		return this.clients.size;
	}
	subscribe(response) {
		if (this.closed) {
			response.end();
			return () => void 0;
		}
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no"
		});
		response.write(": connected\n\n");
		this.clients.add(response);
		const remove = () => {
			this.clients.delete(response);
		};
		response.once("close", remove);
		return remove;
	}
	publish(event) {
		if (this.closed) return;
		const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
		for (const client of [...this.clients]) if (!client.write(frame)) {
			this.clients.delete(client);
			client.end();
		}
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const client of this.clients) client.end();
		this.clients.clear();
	}
};
//#endregion
//#region src/ext/port-log/telnet-server-codec.ts
var TelnetServerCodec = class {
	state = "data";
	decoder = new StringDecoder("utf8");
	pendingCr = false;
	push(chunk) {
		const bytes = [];
		for (const byte of chunk) switch (this.state) {
			case "data":
				if (byte === 255) this.state = "iac";
				else bytes.push(byte);
				break;
			case "iac":
				if (byte === 255) {
					bytes.push(byte);
					this.state = "data";
				} else if (byte === 250) this.state = "subnegotiation";
				else if (byte >= 251 && byte <= 254) this.state = "option";
				else this.state = "data";
				break;
			case "option":
				this.state = "data";
				break;
			case "subnegotiation":
				if (byte === 255) this.state = "subnegotiation-iac";
				break;
			case "subnegotiation-iac": this.state = byte === 240 ? "data" : "subnegotiation";
		}
		return this.normalize(this.decoder.write(Buffer.from(bytes)));
	}
	end() {
		return this.normalize(this.decoder.end(), true);
	}
	normalize(text, flush = false) {
		let result = "";
		for (const char of text) {
			if (this.pendingCr) {
				result += "\r";
				this.pendingCr = false;
				if (char === "\n" || char === "\0") continue;
			}
			if (char === "\r") this.pendingCr = true;
			else result += char;
		}
		if (flush && this.pendingCr) {
			result += "\r";
			this.pendingCr = false;
		}
		return result;
	}
};
function escapeTelnetOutput(data) {
	const parts = [];
	for (const char of data) if (char.codePointAt(0) === 255) parts.push(Buffer.from([255, 255]));
	else parts.push(Buffer.from(char, "utf8"));
	return Buffer.concat(parts);
}
//#endregion
//#region src/ext/port-log/share-manager.ts
const NEGOTIATION = Buffer.from([
	255,
	251,
	1,
	255,
	251,
	3
]);
var ShareManager = class {
	sessions;
	sessionEvents;
	logger;
	events;
	maxBufferedBytes;
	shares = /* @__PURE__ */ new Map();
	closing = false;
	constructor(sessions, sessionEvents, logger, events, maxBufferedBytes = 1048576) {
		this.sessions = sessions;
		this.sessionEvents = sessionEvents;
		this.logger = logger;
		this.events = events;
		this.maxBufferedBytes = maxBufferedBytes;
	}
	list() {
		return [...this.shares.values()].map((runtime) => this.snapshot(runtime));
	}
	async start(input) {
		if (this.closing) throw new PortLogError("MAPPING_STATE", "扩展正在关闭");
		if (this.shares.has(input.sessionId)) throw new PortLogError("SHARE_ALREADY_ACTIVE", "该会话已经在共享");
		if (this.sessions.get(input.sessionId)?.status !== "open") throw new PortLogError("VALIDATION", "只能共享已打开的会话");
		const config = this.validate(input);
		const clients = /* @__PURE__ */ new Map();
		const server = createServer((socket) => this.accept(config.sessionId, socket));
		const runtime = {
			config,
			server,
			clients,
			unsubscribe: () => void 0
		};
		try {
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(config.sharePort, config.localAddr, resolve);
			});
		} catch (error) {
			if (error.code === "EADDRINUSE") throw new PortLogError("PORT_IN_USE", "共享端口已被占用");
			throw new PortLogError("IO_ERROR", "会话共享启动失败");
		}
		runtime.unsubscribe = this.sessionEvents.on((event) => this.handleSessionEvent(config.sessionId, event), {
			type: ["output", "status"],
			sessionId: config.sessionId
		});
		server.on("error", () => {
			runtime.lastError = "共享服务运行错误";
			this.publish(runtime);
		});
		this.shares.set(config.sessionId, runtime);
		await this.logger.log("info", "share.started", {
			sessionId: config.sessionId,
			localAddr: config.localAddr,
			sharePort: config.sharePort
		});
		this.publish(runtime);
		return this.snapshot(runtime);
	}
	async stop(sessionId) {
		const runtime = this.shares.get(sessionId);
		if (runtime === void 0) return;
		await this.stopRuntime(runtime);
	}
	async stopAll() {
		this.closing = true;
		await Promise.allSettled([...this.shares.values()].map((runtime) => this.stopRuntime(runtime)));
	}
	accept(sessionId, socket) {
		const runtime = this.shares.get(sessionId);
		if (runtime === void 0) {
			socket.destroy();
			return;
		}
		if (runtime.config.maxClients > 0 && runtime.clients.size >= runtime.config.maxClients) {
			socket.end("共享客户端数量已达上限\r\n");
			return;
		}
		const id = randomUUID();
		const client = {
			socket,
			codec: new TelnetServerCodec(),
			snapshot: {
				id,
				remoteAddress: socket.remoteAddress ?? "unknown",
				connectedAtMs: Date.now(),
				bytesToClient: 0,
				bytesFromClient: 0
			}
		};
		runtime.clients.set(id, client);
		socket.write(NEGOTIATION);
		if (runtime.config.welcomeMessage.length > 0) socket.write(`${runtime.config.welcomeMessage}\r\n`);
		socket.on("data", (chunk) => {
			client.snapshot.bytesFromClient += chunk.length;
			const data = client.codec.push(chunk);
			if (data.length > 0) this.sessions.write(sessionId, data);
			this.publish(runtime);
		});
		socket.on("error", () => void 0);
		socket.once("close", () => {
			const tail = client.codec.end();
			if (tail.length > 0 && this.sessions.get(sessionId)?.status === "open") this.sessions.write(sessionId, tail);
			runtime.clients.delete(id);
			this.logger.log("info", "share.client_disconnected", {
				sessionId,
				clientId: id
			});
			this.publish(runtime);
		});
		this.logger.log("info", "share.client_connected", {
			sessionId,
			clientId: id,
			remoteAddress: client.snapshot.remoteAddress
		});
		this.publish(runtime);
	}
	handleSessionEvent(sessionId, event) {
		const runtime = this.shares.get(sessionId);
		if (runtime === void 0) return;
		if (event.type === "status") {
			if (event.status === "closed" || event.status === "removed") this.stopRuntime(runtime);
			return;
		}
		if (event.type !== "output") return;
		const payload = escapeTelnetOutput(event.data);
		for (const [id, client] of runtime.clients) {
			if (client.socket.writableLength + payload.length > this.maxBufferedBytes) {
				runtime.clients.delete(id);
				client.socket.destroy();
				continue;
			}
			client.snapshot.bytesToClient += payload.length;
			client.socket.write(payload);
			if (client.socket.writableLength > this.maxBufferedBytes) {
				runtime.clients.delete(id);
				client.socket.destroy();
			}
		}
		this.publish(runtime);
	}
	async stopRuntime(runtime) {
		if (!this.shares.delete(runtime.config.sessionId)) return;
		runtime.unsubscribe();
		const closed = new Promise((resolve) => {
			try {
				runtime.server.close(() => resolve());
			} catch {
				resolve();
			}
		});
		for (const client of runtime.clients.values()) client.socket.destroy();
		runtime.clients.clear();
		await closed;
		await this.logger.log("info", "share.stopped", { sessionId: runtime.config.sessionId });
		this.events.publish({
			type: "share-removed",
			data: { sessionId: runtime.config.sessionId }
		});
	}
	validate(input) {
		if (!Number.isInteger(input.maxClients) || input.maxClients < 0 || input.maxClients > 1e4) throw new PortLogError("VALIDATION", "maxClients 必须是 0–10000 的整数");
		if (typeof input.welcomeMessage !== "string" || input.welcomeMessage.length > 512) throw new PortLogError("VALIDATION", "欢迎语不能超过 512 个字符");
		return {
			sessionId: input.sessionId,
			localAddr: validateLocalAddress(input.localAddr),
			sharePort: validatePort(input.sharePort, "共享端口"),
			maxClients: input.maxClients,
			welcomeMessage: input.welcomeMessage
		};
	}
	snapshot(runtime) {
		return {
			...runtime.config,
			state: runtime.lastError === void 0 ? "running" : "error",
			clients: [...runtime.clients.values()].map((client) => ({ ...client.snapshot })),
			...runtime.lastError === void 0 ? {} : { lastError: runtime.lastError }
		};
	}
	publish(runtime) {
		this.events.publish({
			type: "share-status",
			data: this.snapshot(runtime)
		});
	}
};
//#endregion
//#region src/ext/port-log/terminal-text-normalizer.ts
var TerminalTextNormalizer = class {
	options;
	now;
	ansiState = "text";
	line = [];
	cursor = 0;
	pendingCr = false;
	constructor(options, now = () => /* @__PURE__ */ new Date()) {
		this.options = options;
		this.now = now;
	}
	push(chunk) {
		let output = "";
		for (const char of chunk) {
			const visible = this.options.stripAnsi ? this.filterAnsi(char) : char;
			if (visible === "") continue;
			for (const item of visible) output += this.consume(item);
		}
		return output;
	}
	flush() {
		if (this.line.length === 0) return "";
		const value = this.formatLine(this.line.join(""));
		this.line = [];
		this.cursor = 0;
		this.pendingCr = false;
		return value;
	}
	consume(char) {
		if (char === "\r") {
			this.cursor = 0;
			this.pendingCr = true;
			return "";
		}
		if (char === "\n") {
			const output = this.formatLine(this.line.join(""));
			this.line = [];
			this.cursor = 0;
			this.pendingCr = false;
			return output;
		}
		this.pendingCr = false;
		if (char === "\b") {
			if (this.cursor > 0) {
				this.cursor -= 1;
				this.line.splice(this.cursor, 1);
			}
			return "";
		}
		if (this.cursor < this.line.length) this.line[this.cursor] = char;
		else this.line.push(char);
		this.cursor += 1;
		return "";
	}
	formatLine(line) {
		return `${this.options.timestamp ? `[${this.now().toISOString()}] ` : ""}${line}\n`;
	}
	filterAnsi(char) {
		switch (this.ansiState) {
			case "text":
				if (char === "\x1B") {
					this.ansiState = "escape";
					return "";
				}
				return char;
			case "escape":
				if (char === "[") this.ansiState = "csi";
				else if (char === "]") this.ansiState = "osc";
				else this.ansiState = "text";
				return "";
			case "csi":
				if (char >= "@" && char <= "~") this.ansiState = "text";
				return "";
			case "osc":
				if (char === "\x07") this.ansiState = "text";
				else if (char === "\x1B") this.ansiState = "osc-escape";
				return "";
			case "osc-escape":
				this.ansiState = char === "\\" ? "text" : "osc";
				return "";
		}
	}
};
//#endregion
//#region src/ext/port-log/session-log-manager.ts
function formatFileTimestamp(date) {
	const pad = (value) => String(value).padStart(2, "0");
	const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${milliseconds}`;
}
function safeFileName(value) {
	return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/g, "").slice(0, 120) || "session";
}
var SessionLogManager = class {
	directory;
	sessions;
	sessionEvents;
	logger;
	events;
	maxPendingBytes;
	now;
	logs = /* @__PURE__ */ new Map();
	starting = /* @__PURE__ */ new Map();
	closing = false;
	lastFileTimestampMs = 0;
	constructor(directory, sessions, sessionEvents, logger, events, maxPendingBytes = 1048576, now = () => /* @__PURE__ */ new Date()) {
		this.directory = directory;
		this.sessions = sessions;
		this.sessionEvents = sessionEvents;
		this.logger = logger;
		this.events = events;
		this.maxPendingBytes = maxPendingBytes;
		this.now = now;
	}
	list() {
		return [...this.logs.values()].map((runtime) => this.snapshot(runtime));
	}
	getDefaultDirectory() {
		return this.directory;
	}
	async start(sessionId, options, directory) {
		const pending = this.starting.get(sessionId);
		if (pending !== void 0) return pending;
		const operation = this.startRuntime(sessionId, options, directory);
		this.starting.set(sessionId, operation);
		try {
			return await operation;
		} finally {
			this.starting.delete(sessionId);
		}
	}
	async startRuntime(sessionId, options, directory) {
		if (this.closing) throw new PortLogError("MAPPING_STATE", "扩展正在关闭");
		if (this.logs.has(sessionId)) throw new PortLogError("VALIDATION", "该会话日志已经开启");
		const session = this.sessions.get(sessionId);
		if (session?.status !== "open") throw new PortLogError("VALIDATION", "只能记录已打开的会话");
		this.validateOptions(options);
		const dir = directory && directory.trim() !== "" ? directory.trim() : this.directory;
		await mkdir(dir, {
			recursive: true,
			mode: 448
		});
		const currentTimestampMs = this.now().getTime();
		const fileTimestampMs = Math.max(currentTimestampMs, this.lastFileTimestampMs + 1);
		this.lastFileTimestampMs = fileTimestampMs;
		const stamp = formatFileTimestamp(new Date(fileTimestampMs));
		const path = join(dir, `${safeFileName(session.label)}(${stamp}).log`);
		const stream = createWriteStream(path, {
			flags: "wx",
			mode: 384,
			encoding: "utf8"
		});
		await new Promise((resolve, reject) => {
			stream.once("open", () => resolve());
			stream.once("error", reject);
		}).catch(() => {
			throw new PortLogError("IO_ERROR", "会话日志文件无法创建");
		});
		const runtime = {
			sessionId,
			path,
			options: { ...options },
			normalizer: new TerminalTextNormalizer(options),
			stream,
			unsubscribe: () => void 0,
			bytesWritten: 0,
			pendingBytes: 0,
			queue: Promise.resolve(),
			stopping: false,
			failed: false
		};
		runtime.unsubscribe = this.sessionEvents.on((event) => this.handleEvent(runtime, event), {
			type: ["output", "status"],
			sessionId
		});
		stream.on("error", () => this.fail(runtime, "会话日志写入失败"));
		this.logs.set(sessionId, runtime);
		await this.logger.log("info", "session_log.started", {
			sessionId,
			path,
			timestamp: options.timestamp,
			stripAnsi: options.stripAnsi
		});
		this.publish(runtime);
		return this.snapshot(runtime);
	}
	async update(sessionId, options) {
		const runtime = this.requireRuntime(sessionId);
		this.validateOptions(options);
		const tail = runtime.normalizer.flush();
		if (tail.length > 0) this.enqueueWrite(runtime, tail);
		runtime.options = { ...options };
		runtime.normalizer = new TerminalTextNormalizer(options);
		this.publish(runtime);
		return this.snapshot(runtime);
	}
	async stop(sessionId) {
		const runtime = this.requireRuntime(sessionId);
		await this.stopRuntime(runtime);
	}
	async closeAll() {
		this.closing = true;
		await Promise.allSettled([...this.logs.values()].map((runtime) => this.stopRuntime(runtime)));
	}
	handleEvent(runtime, event) {
		if (runtime.stopping || runtime.failed) return;
		if (event.type === "status") {
			if (event.status === "closed" || event.status === "removed") this.stopRuntime(runtime);
			return;
		}
		if (event.type !== "output") return;
		const text = runtime.normalizer.push(event.data);
		if (text.length > 0) this.enqueueWrite(runtime, text);
	}
	enqueueWrite(runtime, text) {
		const bytes = Buffer.byteLength(text);
		if (runtime.pendingBytes + bytes > this.maxPendingBytes) {
			this.fail(runtime, "会话日志写入积压超过限制", "IO_BACKPRESSURE");
			return;
		}
		runtime.pendingBytes += bytes;
		runtime.queue = runtime.queue.then(() => new Promise((resolve, reject) => {
			runtime.stream.write(text, "utf8", (error) => error ? reject(error) : resolve());
		})).then(() => {
			runtime.pendingBytes -= bytes;
			runtime.bytesWritten += bytes;
			this.publish(runtime);
		}).catch(() => {
			runtime.pendingBytes -= bytes;
			this.fail(runtime, "会话日志写入失败", "IO_ERROR");
		});
	}
	fail(runtime, message, code = "IO_ERROR") {
		if (runtime.failed || runtime.stopping) return;
		runtime.failed = true;
		runtime.lastError = message;
		this.publish(runtime);
		this.logger.log("error", "session_log.failed", {
			sessionId: runtime.sessionId,
			code
		});
		this.stopRuntime(runtime);
	}
	async stopRuntime(runtime) {
		if (runtime.stopping) return runtime.queue;
		runtime.stopping = true;
		runtime.unsubscribe();
		const tail = runtime.normalizer.flush();
		if (tail.length > 0 && !runtime.failed) this.enqueueWrite(runtime, tail);
		await runtime.queue.catch(() => void 0);
		await new Promise((resolve) => {
			if (runtime.stream.closed) resolve();
			else runtime.stream.end(() => resolve());
		});
		this.logs.delete(runtime.sessionId);
		await this.logger.log("info", "session_log.stopped", {
			sessionId: runtime.sessionId,
			bytesWritten: runtime.bytesWritten
		});
		this.events.publish({
			type: "session-log-status",
			data: {
				sessionId: runtime.sessionId,
				state: "stopped",
				path: runtime.path,
				bytesWritten: runtime.bytesWritten,
				...runtime.lastError === void 0 ? {} : { lastError: runtime.lastError }
			}
		});
	}
	requireRuntime(sessionId) {
		const runtime = this.logs.get(sessionId);
		if (runtime === void 0) throw new PortLogError("VALIDATION", "该会话日志未开启");
		return runtime;
	}
	validateOptions(options) {
		if (typeof options.timestamp !== "boolean" || typeof options.stripAnsi !== "boolean") throw new PortLogError("VALIDATION", "会话日志选项无效");
	}
	snapshot(runtime) {
		return {
			sessionId: runtime.sessionId,
			state: runtime.failed ? "error" : "running",
			path: runtime.path,
			bytesWritten: runtime.bytesWritten,
			...runtime.options,
			...runtime.lastError === void 0 ? {} : { lastError: runtime.lastError }
		};
	}
	publish(runtime) {
		this.events.publish({
			type: "session-log-status",
			data: this.snapshot(runtime)
		});
	}
};
//#endregion
//#region src/ext/port-log/directory-picker.ts
function createDirectoryPicker(getService) {
	let busy = false;
	return async (signal) => {
		const capability = getService()?.capability();
		if (capability?.kind !== "native" || !capability.pick) throw new PortLogError("IO_ERROR", "当前 DSH 未启用系统目录选择器");
		if (busy) throw new PortLogError("IO_ERROR", "目录选择窗口已打开，请先完成选择或取消");
		signal.throwIfAborted();
		busy = true;
		try {
			return await capability.pick(signal);
		} catch {
			throw new PortLogError("IO_ERROR", "无法打开系统目录选择器，请重试");
		} finally {
			busy = false;
		}
	};
}
//#endregion
//#region src/ext/port-log/index.ts
/**
* 端口映射、会话共享与日志扩展的 host 入口。
*
* E0 仅建立可确定卸载的生命周期边界；后续能力都在本目录内装配。
*/
function registerPortLogExtension(ctx, deps) {
	if (typeof ctx.effect !== "function" || typeof ctx.get !== "function") return void 0;
	const root = join(deps.dataDir, "ext", "port-log");
	const logger = new AppLogger$1(join(root, "log"));
	const store = new MappingStore(join(root, "mappings.json"));
	const events = new RuntimeEventHub();
	const mappings = new MappingManager(store, logger, events);
	const shares = new ShareManager(deps.sessions, deps.events, logger, events);
	const sessionLogs = new SessionLogManager(join(root, "session_logs"), deps.sessions, deps.events, logger, events);
	const lifetime = new AbortController();
	const pickDirectory = createDirectoryPicker(() => ctx.get("directoryPicker"));
	const unsubscribeMetadata = deps.events.on((event) => {
		if (event.type === "status") logger.log("info", "session.status", {
			sessionId: event.sessionId,
			status: event.status,
			protocol: event.snapshot.protocol
		});
		else if (event.type === "file") logger.log(event.ok ? "info" : "warn", "session.file", {
			sessionId: event.sessionId,
			operation: event.op,
			ok: event.ok,
			bytes: event.bytes
		});
	}, { type: ["status", "file"] });
	const ready = mappings.initialize().then(() => logger.log("info", "extension.started")).then(() => mappings.autoStart());
	const api = {
		ready,
		mappings: {
			list: () => mappings.list(),
			async create(input) {
				await ready;
				return mappings.create(input);
			},
			async update(id, patch) {
				await ready;
				return mappings.update(id, patch);
			},
			async remove(id) {
				await ready;
				await mappings.remove(id);
			},
			async start(id) {
				await ready;
				return mappings.start(id);
			},
			async stop(id) {
				await ready;
				return mappings.stop(id);
			},
			async importCsv(csv) {
				await ready;
				return mappings.merge(parseMappingsCsv(csv));
			},
			exportCsv: () => exportMappingsCsv(mappings.list())
		},
		shares: {
			list: () => shares.list(),
			async start(input) {
				await ready;
				if (deps.events === void 0) throw new Error("会话服务尚未就绪");
				return shares.start({
					sessionId: String(input.sessionId ?? ""),
					localAddr: typeof input.localAddr === "string" ? input.localAddr : "0.0.0.0",
					sharePort: Number(input.sharePort ?? 2323),
					maxClients: Number(input.maxClients ?? 0),
					welcomeMessage: typeof input.welcomeMessage === "string" ? input.welcomeMessage : ""
				});
			},
			async stop(sessionId) {
				await ready;
				await shares.stop(sessionId);
			}
		},
		sessionLogs: {
			list: () => sessionLogs.list(),
			async start(sessionId, options, directory) {
				await ready;
				return sessionLogs.start(sessionId, {
					timestamp: options.timestamp === true,
					stripAnsi: options.stripAnsi !== false
				}, directory);
			},
			async update(sessionId, options) {
				await ready;
				return sessionLogs.update(sessionId, {
					timestamp: options.timestamp === true,
					stripAnsi: options.stripAnsi !== false
				});
			},
			async stop(sessionId) {
				await ready;
				await sessionLogs.stop(sessionId);
			},
			getDefaultDirectory: () => sessionLogs.getDefaultDirectory(),
			async listDir(rawPath) {
				const raw = rawPath?.trim() ?? "";
				const dir = raw === "" ? sessionLogs.getDefaultDirectory() : resolve(raw);
				const dirs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b, void 0, { sensitivity: "base" }));
				return {
					path: dir,
					parent: (sep === "/" ? dir === "/" : /^[A-Za-z]:[\\/]?$/.test(dir)) ? null : resolve(dir, ".."),
					dirs
				};
			},
			knownFolders: () => resolveKnownFolders()
		}
	};
	ctx.effect(() => {
		const webServer = ctx.get("webServer");
		const connection = ctx.get("connection");
		const routerDeps = {
			store,
			mappings,
			shares,
			sessions: deps.sessions,
			sessionLogs,
			logger,
			events,
			ready,
			pickDirectory: (signal) => pickDirectory(AbortSignal.any([signal, lifetime.signal]))
		};
		const rpcHandler = createPortLogRpcHandler(routerDeps);
		const routeDisposers = [];
		for (const method of PORT_LOG_METHODS) {
			const disposer = connection?.fetch?.register({
				path: `/api/${PORT_LOG_ENDPOINT_PREFIX}${method}`,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					let rpcId = "invalid";
					let payload = {};
					try {
						const body = await request.json();
						if (typeof body.rpcId === "string") rpcId = body.rpcId;
						payload = body.payload ?? {};
					} catch {
						return Response.json({
							type: "server-response",
							rpcId,
							result: {
								ok: false,
								error: {
									code: "VALIDATION",
									message: "请求体不是 JSON",
									details: {}
								}
							}
						}, { status: 400 });
					}
					const result = await rpcHandler(method, payload, request.signal);
					return Response.json({
						type: "server-response",
						rpcId,
						result
					});
				}
			});
			if (disposer !== void 0) routeDisposers.push(disposer);
		}
		const eventsHandler = createPortLogEventsHandler(routerDeps);
		const unregister = webServer?.register({
			kind: "exact",
			path: PORT_LOG_EVENTS_PATH,
			handler: (request, response) => {
				const admission = connection?.admit(request);
				if (admission === void 0 || "rejection" in admission) {
					const status = admission !== void 0 && "rejection" in admission ? admission.rejection : 401;
					response.writeHead(status);
					response.end();
					return;
				}
				eventsHandler(request, response);
			}
		}) ?? (() => void 0);
		return async () => {
			lifetime.abort();
			unregister();
			await Promise.all(routeDisposers.map((dispose) => dispose()));
			events.close();
			unsubscribeMetadata();
			await ready.catch(() => void 0);
			await shares.stopAll();
			await sessionLogs.closeAll();
			await mappings.stopAll();
			await logger.log("info", "extension.stopped");
			await logger.close();
		};
	}, "terminal-manager: port-log extension");
	return api;
}
//#endregion
//#region src/ext/index.ts
/** 挂载全部扩展模块，返回 AI 工具层可用的能力句柄。 */
function registerExtensions(ctx, deps) {
	const portLog = registerPortLogExtension(ctx, deps);
	return { ...portLog !== void 0 ? { portLog } : {} };
}
//#endregion
//#region src/file-errors.ts
var FileServiceError = class extends Error {
	code;
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "FileServiceError";
	}
};
/** 把 Node 的文件系统错误映射成统一错误码。 */
function mapFsError(error, what) {
	if (error instanceof FileServiceError) return error;
	const code = error?.code;
	if (code === "ENOENT" || code === "ENOTDIR") return new FileServiceError("NOT_FOUND", `${what}不存在`, { cause: error });
	if (code === "EACCES" || code === "EPERM") return new FileServiceError("VALIDATION", `${what}没有访问权限`, { cause: error });
	if (code === "EISDIR") return new FileServiceError("VALIDATION", `${what}是目录不是文件`, { cause: error });
	return new FileServiceError("REMOTE_IO", `${what}读写失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}
//#endregion
//#region src/path-security.ts
/**
* B10 路径安全 —— 所有本地文件操作前的围栏：归一化 → 解析符号链接 → 校验在树根内。
*
* 改编自 DSH-better-sidebar（MIT）的 src/path-security.ts + src/fs-tree.ts 的 isWithin/requireAbsolute，
* 错误类换成本插件的 FileServiceError。
* 规则：越界抛 PATH_OUTSIDE_ROOT；空路径 / 含 \0 / 相对路径抛 VALIDATION；不存在抛 NOT_FOUND。
* @module dsh-terminal-manager/path-security
*/
/** 纯函数：target 是否在 base 内（含 base 本身）。win32 大小写不敏感，斜杠统一。 */
function isWithin(base, target, platform = process.platform) {
	const norm = (value) => value.replace(/[\\/]+/g, "/").replace(/\/$/, "");
	const b = norm(base);
	const t = norm(target);
	if (platform === "win32") {
		const lb = b.toLowerCase();
		const lt = t.toLowerCase();
		return lt === lb || lt.startsWith(`${lb}/`);
	}
	return t === b || t.startsWith(`${b}/`);
}
/** 纯函数：基本形态校验，返回归一化后的绝对路径。 */
function requireAbsolute(path) {
	if (typeof path !== "string" || path.trim().length === 0) throw new FileServiceError("VALIDATION", "路径为空");
	if (path.includes("\0")) throw new FileServiceError("VALIDATION", "路径含非法字符");
	if (!isAbsolute(path)) throw new FileServiceError("VALIDATION", "路径必须是绝对路径");
	return resolve(path);
}
async function realpathOf(path, what) {
	try {
		return await realpath(path);
	} catch (error) {
		throw mapFsError(error, what);
	}
}
/**
* 读操作围栏：target 必须已存在。解析 root 与 target 的真实路径（穿透符号链接）后校验包含关系。
* @returns target 的真实绝对路径（后续 fs 操作用它，不用用户传的原串）
*/
async function resolveInsideRoot(root, target) {
	const absolute = requireAbsolute(target);
	const realRoot = await realpathOf(requireAbsolute(root), "树根目录");
	let realTarget;
	try {
		realTarget = await realpath(absolute);
	} catch (error) {
		if (error.code !== "ENOENT") throw mapFsError(error, "路径");
		await resolveWritePathInsideRoot(root, target);
		throw new FileServiceError("NOT_FOUND", "路径不存在");
	}
	if (!isWithin(realRoot, realTarget)) throw new FileServiceError("PATH_OUTSIDE_ROOT", "路径在当前文件树根之外");
	return realTarget;
}
/**
* 写操作围栏：target 可以尚不存在。沿父目录向上找到第一个存在的祖先，解析其真实路径并校验在树根内，
* 再把缺失段拼回去。这样路径里已存在的符号链接一定被穿透，写入不会落到根外。
*/
async function resolveWritePathInsideRoot(root, target) {
	const absolute = requireAbsolute(target);
	const realRoot = await realpathOf(requireAbsolute(root), "树根目录");
	let existing = absolute;
	const missingSegments = [];
	for (;;) try {
		const real = await realpath(existing);
		if (!isWithin(realRoot, real)) throw new FileServiceError("PATH_OUTSIDE_ROOT", "路径在当前文件树根之外");
		return {
			path: missingSegments.reduce((acc, seg) => join(acc, seg), real),
			missingSegments
		};
	} catch (error) {
		if (error instanceof FileServiceError) throw error;
		if (error.code !== "ENOENT") throw mapFsError(error, "路径");
		const parent = dirname(existing);
		if (parent === existing) throw new FileServiceError("NOT_FOUND", "路径的任何祖先目录都不存在");
		missingSegments.unshift(basename(existing));
		existing = parent;
	}
}
//#endregion
//#region src/file-service.ts
/**
* B10 文件服务 —— 契约 `src/types/file-service.ts` 的实现。
*
* S1：本地四件套（listLocal / readLocal / writeLocal / listDirectories），全部经 path-security 围栏；
* S5：远端四方法按会话协议分派（SSH → SftpLike 门面；Telnet → UNSUPPORTED）。
* 目录列表排序改编自 DSH-better-sidebar（MIT）src/fs-tree.ts。
* @module dsh-terminal-manager/file-service
*/
/** 编辑器打开上限（超出只读 + 截断）。 */
const DEFAULT_MAX_READ_BYTES = 10485760;
/** 目录优先，再按名字不分大小写排序（VSCode 资源管理器顺序）。 */
function compareEntries(a, b) {
	const aDir = a.kind === "dir";
	if (aDir !== (b.kind === "dir")) return aDir ? -1 : 1;
	return a.name.localeCompare(b.name, void 0, { sensitivity: "base" });
}
/**
* 原子 rename。Windows 上并发写同一目标时 rename 会撞 EPERM/EACCES
* （目标文件正被另一个 rename 操作占用），短暂退避重试即可——
* 临时文件还在，竞争是瞬时的。
*/
async function renameAtomic(src, dest, retries = 6) {
	for (let attempt = 0;; attempt++) try {
		await rename(src, dest);
		return;
	} catch (error) {
		const code = error?.code;
		if (attempt < retries && (code === "EPERM" || code === "EACCES")) {
			await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
			continue;
		}
		throw error;
	}
}
async function entryOf(dir, name, dirent) {
	const path = join(dir, name);
	if (dirent.isSymbolicLink()) return {
		name,
		path,
		kind: "symlink"
	};
	if (dirent.isDirectory()) return {
		name,
		path,
		kind: "dir"
	};
	if (dirent.isFile()) try {
		const s = await stat(path);
		return {
			name,
			path,
			kind: "file",
			size: s.size,
			mtimeMs: s.mtimeMs
		};
	} catch {
		return {
			name,
			path,
			kind: "file"
		};
	}
	return {
		name,
		path,
		kind: "other"
	};
}
/** 本地文件服务实现。 */
var LocalFileService = class {
	sessions;
	events;
	maxReadBytes;
	constructor(sessions, events, maxReadBytes = DEFAULT_MAX_READ_BYTES) {
		this.sessions = sessions;
		this.events = events;
		this.maxReadBytes = maxReadBytes;
	}
	async listLocal(ref) {
		const real = await resolveInsideRoot(ref.root, ref.path);
		let dirents;
		try {
			dirents = await readdir(real, { withFileTypes: true });
		} catch (error) {
			throw mapFsError(error, "目录");
		}
		return (await Promise.all(dirents.map((d) => entryOf(real, d.name, d)))).sort(compareEntries);
	}
	async readLocal(ref, opts = {}) {
		const real = await resolveInsideRoot(ref.root, ref.path);
		const maxBytes = opts.maxBytes ?? this.maxReadBytes;
		let size;
		try {
			const s = await stat(real);
			if (s.isDirectory()) throw new FileServiceError("VALIDATION", "路径是目录不是文件");
			size = s.size;
		} catch (error) {
			throw mapFsError(error, "文件");
		}
		try {
			if (size <= maxBytes) return {
				content: await readFile(real, "utf8"),
				size,
				truncated: false
			};
			const fh = await open(real, "r");
			try {
				const buf = Buffer.alloc(maxBytes);
				const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
				return {
					content: buf.subarray(0, bytesRead).toString("utf8"),
					size,
					truncated: true
				};
			} finally {
				await fh.close();
			}
		} catch (error) {
			throw mapFsError(error, "文件");
		}
	}
	async writeLocal(ref, content) {
		const { path, missingSegments } = await resolveWritePathInsideRoot(ref.root, ref.path);
		if (missingSegments.length > 1) throw new FileServiceError("NOT_FOUND", "父目录不存在（不自动创建目录）");
		if (missingSegments.length === 0) try {
			if ((await stat(path)).isDirectory()) throw new FileServiceError("VALIDATION", "路径是目录不是文件");
		} catch (error) {
			throw mapFsError(error, "文件");
		}
		const tmp = join(dirname(path), `.${basename(path)}.tm-tmp-${randomBytes(4).toString("hex")}`);
		try {
			await writeFile(tmp, content, "utf8");
			await renameAtomic(tmp, path);
		} catch (error) {
			await unlink(tmp).catch(() => {});
			throw mapFsError(error, "文件");
		}
		return { bytes: Buffer.byteLength(content, "utf8") };
	}
	async listDirectories(absPath) {
		const path = requireAbsolute(absPath);
		let dirents;
		try {
			dirents = await readdir(path, { withFileTypes: true });
		} catch (error) {
			throw mapFsError(error, "目录");
		}
		return dirents.filter((d) => d.isDirectory()).map((d) => ({
			name: d.name,
			path: join(path, d.name),
			kind: "dir"
		})).sort(compareEntries);
	}
	/**
	* 取会话的 SFTP 门面（分片上传等新能力复用同一套会话/协议校验；错误码同远端四方法）。
	* 日常远端四方法仍走私有 requireSftp，避免契约面扩大。
	*/
	async getSftp(sessionId) {
		return this.requireSftp(sessionId);
	}
	/**
	* 远端操作前置分派：会话存在 → open → SSH → 拿 SFTP 门面。
	* 无 SESSION_BUSY 锁：SFTP 是 SSH 独立子通道，不碰 PTY 字节流，与终端交互互不干扰。
	* 传输层错误映射：DISCONNECTED 保留，其余归 REMOTE_IO。
	*/
	async requireSftp(sessionId) {
		if (this.sessions === void 0) throw new FileServiceError("UNSUPPORTED", "文件服务未接入会话池（远端操作不可用）");
		const snap = this.sessions.get(sessionId);
		if (snap === void 0) throw new FileServiceError("SESSION_NOT_FOUND", `会话不存在: ${sessionId}`);
		if (snap.status !== "open") throw new FileServiceError("DISCONNECTED", "会话已断开");
		if (snap.protocol !== "ssh") throw new FileServiceError("UNSUPPORTED", "Telnet 会话不支持文件传输（仅 SSH/SFTP）");
		try {
			return await this.sessions.getSftp(sessionId);
		} catch (error) {
			if (error?.code === "DISCONNECTED") throw new FileServiceError("DISCONNECTED", "SSH 连接已断开，无法进行文件操作", { cause: error });
			throw new FileServiceError("REMOTE_IO", `打开 SFTP 通道失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}
	async listRemote(req) {
		return (await (await this.requireSftp(req.sessionId)).list(req.path)).sort(compareEntries);
	}
	/** 获取远端终端当前工作目录（SFTP realpath('.')） */
	async remoteCwd(req) {
		return await (await this.requireSftp(req.sessionId)).realpath(".");
	}
	async upload(req) {
		const sftp = await this.requireSftp(req.sessionId);
		const started = Date.now();
		try {
			const source = req.source.kind === "local" ? {
				kind: "path",
				path: await resolveInsideRoot(req.source.ref.root, req.source.ref.path)
			} : {
				kind: "stream",
				stream: req.source.stream,
				...req.source.size !== void 0 ? { size: req.source.size } : {}
			};
			const { onProgress, transferred } = this.progressMapper("upload", req.sessionId, req.remotePath, req.onProgress);
			const { bytes } = await sftp.put(source, req.remotePath, { ...onProgress !== void 0 ? { onProgress } : {} });
			this.emitFile(req.sessionId, "upload", req.remotePath, true, bytes);
			return {
				ok: true,
				bytes,
				durationMs: Date.now() - started
			};
		} catch (error) {
			this.emitFile(req.sessionId, "upload", req.remotePath, false, void 0, error);
			throw error;
		}
	}
	async download(req) {
		const sftp = await this.requireSftp(req.sessionId);
		const { onProgress, transferred } = this.progressMapper("download", req.sessionId, req.remotePath, req.onProgress);
		const { stream, size } = await sftp.downloadStream(req.remotePath, { ...onProgress !== void 0 ? { onProgress } : {} });
		this.watchStreamEnd(req.sessionId, req.remotePath, stream, transferred);
		return {
			stream,
			...size !== void 0 ? { size } : {}
		};
	}
	async downloadToLocal(req) {
		const sftp = await this.requireSftp(req.sessionId);
		const started = Date.now();
		let temp;
		try {
			const { path: targetPath, missingSegments } = await resolveWritePathInsideRoot(req.target.root, req.target.path);
			if (missingSegments.length > 1) throw new FileServiceError("NOT_FOUND", "父目录不存在（不自动创建目录）");
			temp = join(dirname(targetPath), `.${basename(targetPath)}.tm-partial-${randomBytes(4).toString("hex")}`);
			const { onProgress } = this.progressMapper("download", req.sessionId, req.remotePath, req.onProgress);
			const { bytes } = await sftp.get(req.remotePath, temp, { ...onProgress !== void 0 ? { onProgress } : {} });
			await rename(temp, targetPath);
			this.emitFile(req.sessionId, "download", req.remotePath, true, bytes);
			return {
				ok: true,
				bytes,
				durationMs: Date.now() - started,
				localPath: targetPath
			};
		} catch (error) {
			if (temp !== void 0) await unlink(temp).catch(() => {});
			this.emitFile(req.sessionId, "download", req.remotePath, false, void 0, error);
			throw error;
		}
	}
	/** 把 SftpProgress 转成契约 TransferProgress 回调；transferred() 取终值（供结束事件的 bytes）。 */
	progressMapper(op, sessionId, remotePath, cb) {
		let transferred = 0;
		if (cb === void 0) return { transferred: () => transferred };
		return {
			onProgress: (t, total) => {
				transferred = t;
				cb({
					op,
					sessionId,
					remotePath,
					transferred: t,
					...total !== void 0 ? { total } : {},
					...total > 0 ? { percent: Math.min(100, Math.round(t / total * 100)) } : {}
				});
			},
			transferred: () => transferred
		};
	}
	/** 流式下载的结束事件：end=成功；error=失败；close 而未 end=被取消（如 HTTP 响应中止）。 */
	watchStreamEnd(sessionId, remotePath, stream, transferred) {
		let settled = false;
		stream.once("end", () => {
			if (settled) return;
			settled = true;
			this.emitFile(sessionId, "download", remotePath, true, transferred());
		});
		stream.once("error", (error) => {
			if (settled) return;
			settled = true;
			this.emitFile(sessionId, "download", remotePath, false, void 0, error);
		});
		stream.once("close", () => {
			if (settled) return;
			settled = true;
			this.emitFile(sessionId, "download", remotePath, false, void 0, /* @__PURE__ */ new Error("传输被取消"));
		});
	}
	/** 传输结束事件（成功/失败/取消都发；path = 远端路径，upload=目标 / download=源）。 */
	emitFile(sessionId, op, path, ok, bytes, error) {
		this.events?.emit({
			type: "file",
			sessionId,
			op,
			path,
			ok,
			...bytes !== void 0 ? { bytes } : {},
			...error !== void 0 ? { error: error instanceof Error ? error.message : String(error) } : {},
			ts: Date.now()
		});
	}
};
//#endregion
//#region src/logger.ts
/**
* 插件共享文件日志（host 半）——连接、会话、文件传输、上传与扩展共用。
*
* 与 port-log 的 AppLogger 能力一致：级别过滤、串行写入、5 MiB×5 轮转、
* 单行 16 KiB 截断、递归脱敏、换行替换防注入、循环引用标记、目录不可写降级。
* 不采集/不落盘任何凭据；message 与 fields 都先脱敏再写。
*
* @module dsh-terminal-manager/logger
*/
const LEVEL_RANK = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};
const SENSITIVE_KEY = /^(password|privatekey|passphrase|authorization|token|secret|credential)$/i;
const MAX_LINE_BYTES = 16384;
function sanitize(value, seen = /* @__PURE__ */ new WeakSet()) {
	if (value === null || typeof value !== "object") {
		if (typeof value === "string") return value.replace(/[\r\n]+/g, " ");
		return value;
	}
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
	const result = {};
	for (const [key, item] of Object.entries(value)) result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, seen);
	return result;
}
var AppLogger = class {
	directory;
	currentFile;
	maxBytes;
	maxFiles;
	now;
	tag;
	level;
	size = 0;
	ready;
	queue = Promise.resolve();
	closed = false;
	lastError;
	constructor(directory, options = {}) {
		this.directory = directory;
		this.currentFile = join(directory, "app.log");
		this.level = options.level ?? "info";
		this.maxBytes = options.maxBytes ?? 5242880;
		this.maxFiles = options.maxFiles ?? 5;
		this.now = options.now ?? (() => /* @__PURE__ */ new Date());
		this.tag = options.tag ?? "[term-manager]";
	}
	setLevel(level) {
		this.level = level;
	}
	log(level, event, fields = {}) {
		if (this.closed || LEVEL_RANK[level] < LEVEL_RANK[this.level]) return this.queue;
		this.queue = this.queue.then(async () => {
			try {
				await this.ensureReady();
				let line = `${this.now().toISOString()} ${level.toUpperCase()} ${event} ${JSON.stringify(sanitize(fields))}\n`;
				if (Buffer.byteLength(line) > MAX_LINE_BYTES) line = `${this.now().toISOString()} ${level.toUpperCase()} ${event} {"truncated":true}\n`;
				const bytes = Buffer.byteLength(line);
				if (this.size > 0 && this.size + bytes > this.maxBytes) await this.rotate();
				const file = await open(this.currentFile, "a", 384);
				try {
					await file.writeFile(line, "utf8");
					await file.sync();
				} finally {
					await file.close();
				}
				this.size += bytes;
			} catch {
				this.lastError = "应用日志写入失败";
				console.error(`${this.tag} application log write failed`);
			}
		});
		return this.queue;
	}
	async status() {
		await this.queue;
		await this.ensureReady();
		const names = (await readdir(this.directory)).filter((name) => /^app\.log(?:\.\d+)?$/.test(name)).sort();
		const files = await Promise.all(names.map(async (name) => {
			const path = join(this.directory, name);
			return {
				path,
				bytes: (await stat(path)).size
			};
		}));
		return {
			level: this.level,
			directory: this.directory,
			currentFile: this.currentFile,
			files,
			...this.lastError === void 0 ? {} : { lastError: this.lastError }
		};
	}
	async close() {
		this.closed = true;
		await this.queue;
	}
	async ensureReady() {
		this.ready ??= (async () => {
			await mkdir(this.directory, {
				recursive: true,
				mode: 448
			});
			try {
				this.size = (await stat(this.currentFile)).size;
			} catch {
				this.size = 0;
			}
		})();
		await this.ready;
	}
	async rotate() {
		const oldest = join(this.directory, `app.log.${this.maxFiles - 1}`);
		await rm(oldest, { force: true });
		for (let index = this.maxFiles - 2; index >= 1; index -= 1) try {
			await rename(join(this.directory, `app.log.${index}`), join(this.directory, `app.log.${index + 1}`));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		try {
			await rename(this.currentFile, join(this.directory, "app.log.1"));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		this.size = 0;
	}
};
//#endregion
//#region src/open-external.ts
/**
* 用系统默认程序打开本机文件（Excel / Word / PDF 等不在编辑器里打开的类型）。
* 只负责「调起」，路径合法性由调用方（remotes 的 files.open）先经路径围栏校验。
* @module dsh-terminal-manager/open-external
*/
/** 缺省实现：起一个分离的子进程，不等待程序退出。 */
const defaultSpawn = (cmd, args) => new Promise((resolve, reject) => {
	const child = spawn(cmd, args, {
		detached: true,
		stdio: "ignore",
		windowsHide: true
	});
	child.once("error", reject);
	child.once("spawn", () => {
		child.unref();
		resolve();
	});
});
/** Windows 日志直接交给记事本，不依赖 .log 文件关联，也不经过 cmd 解析路径。其他文件沿用系统默认程序。 */
function openCommandFor(platform, path) {
	if (platform === "win32" && extname(path).toLowerCase() === ".log") return {
		cmd: "notepad.exe",
		args: [path]
	};
	if (platform === "win32") return {
		cmd: "cmd",
		args: [
			"/c",
			"start",
			"",
			path
		]
	};
	if (platform === "darwin") return {
		cmd: "open",
		args: [path]
	};
	return {
		cmd: "xdg-open",
		args: [path]
	};
}
/** 调起系统默认程序打开 path。 */
async function openWithSystem(path, spawnFn = defaultSpawn, platform = process.platform) {
	const { cmd, args } = openCommandFor(platform, path);
	await spawnFn(cmd, args);
}
//#endregion
//#region src/local-panel-state.ts
function createLocalPanelState() {
	return {
		root: "",
		cwd: ""
	};
}
/** 取有效树根：面板已同步用面板 root，否则回退 workspaceRoot。 */
function effectiveRoot(state, fallback) {
	return state.root.length > 0 ? state.root : fallback;
}
/** 取有效目录：面板已同步用面板 cwd，否则回退 workspaceRoot。 */
function effectiveCwd(state, fallback) {
	return state.cwd.length > 0 ? state.cwd : fallback;
}
/** 单次 write 的绝对超时（毫秒）。 */
const DEFAULT_WRITE_TIMEOUT_MS = 6e4;
/** 从环境变量读超时；非法值回退默认。 */
function timeoutFromEnv() {
	const raw = process.env.TM_SFTP_WRITE_TIMEOUT_MS;
	if (raw === void 0 || raw.trim().length === 0) return DEFAULT_WRITE_TIMEOUT_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_WRITE_TIMEOUT_MS;
}
/** 把任意错误统一成 FileServiceError（FileServiceError 原样透传）。 */
function writerError(error, what) {
	if (error instanceof FileServiceError) return error;
	return new FileServiceError("REMOTE_IO", `${what}失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}
/** 绝对超时：到点 reject；原 promise 完成时清掉定时器。 */
function withTimeout(promise, timeoutMs) {
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new FileServiceError("REMOTE_IO", `SFTP 写入超时（超过 ${timeoutMs}ms 未完成）`));
		}, timeoutMs);
		timer.unref?.();
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== void 0) clearTimeout(timer);
	});
}
/** 固定并发跑一组任务；任一失败后其余 worker 不再领新任务。 */
async function runPool(tasks, concurrency) {
	let cursor = 0;
	let failed = false;
	const workers = Array.from({ length: Math.min(Math.max(1, concurrency), tasks.length) }, async () => {
		for (;;) {
			if (failed) return;
			const index = cursor++;
			if (index >= tasks.length) return;
			try {
				await tasks[index]();
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	});
	await Promise.all(workers);
}
/**
* 基于 SFTP 句柄的并发写入器。
* 生命周期：`open` → 多次 `write` → `close`（幂等）。
*/
var SftpConcurrentWriter = class SftpConcurrentWriter {
	subPacketBytes;
	concurrency;
	timeoutMs;
	closed = false;
	failed = false;
	handle;
	constructor(handle, options = {}) {
		this.handle = handle;
		this.subPacketBytes = options.subPacketBytes ?? 262144;
		this.concurrency = options.concurrency ?? 32;
		this.timeoutMs = options.timeoutMs ?? timeoutFromEnv();
	}
	/** 打开远端文件并返回写入器（mode='w' 截断新建；'r+' 保留已有内容续传）。 */
	static async open(sftp, path, options = {}) {
		if (typeof sftp.openWrite !== "function") throw new FileServiceError("UNSUPPORTED", "该 SFTP 门面不支持分片写入");
		const handle = await sftp.openWrite(path, options.mode ?? "w");
		return new SftpConcurrentWriter(handle, options);
	}
	/** 句柄状态（poisoned = 已因超时/失败失效，不能再写）。 */
	get props() {
		return { poisoned: this.failed };
	}
	/**
	* 在 position 处写入 buffer：拆 256 KiB 子包、并发 pwrite。
	* 超时/失败会 poison 写入器；之后调用直接失败。
	*/
	async write(buffer, position) {
		if (this.closed) throw new FileServiceError("REMOTE_IO", "SFTP 写入句柄已关闭");
		if (this.failed) throw new FileServiceError("REMOTE_IO", "SFTP 写入句柄已失效，无法继续写入");
		if (!Number.isSafeInteger(position) || position < 0) throw new FileServiceError("VALIDATION", "写入位置必须是非负整数");
		if (buffer.length === 0) return;
		const handle = this.handle;
		if (handle === void 0) throw new FileServiceError("REMOTE_IO", "SFTP 写入句柄已关闭");
		const tasks = [];
		for (let offset = 0; offset < buffer.length; offset += this.subPacketBytes) {
			const end = Math.min(offset + this.subPacketBytes, buffer.length);
			const slice = buffer.subarray(offset, end);
			const at = position + offset;
			tasks.push(() => handle.write(slice, at));
		}
		try {
			await withTimeout(runPool(tasks, this.concurrency), this.timeoutMs);
		} catch (error) {
			this.failed = true;
			throw writerError(error, "SFTP 分片写入");
		}
	}
	/** 关闭句柄（幂等；关闭失败静默——临时文件可被重新打开或清理）。 */
	async close() {
		if (this.closed) return;
		this.closed = true;
		const handle = this.handle;
		this.handle = void 0;
		if (handle === void 0) return;
		try {
			await handle.close();
		} catch {}
	}
};
/** 单分片上限（防御性；客户端用 4 MiB）。 */
const MAX_CHUNK_SIZE = 67108864;
/** 分片数上限（1 字节分片也最多 100 万片，防异常请求撑爆内存）。 */
const MAX_TOTAL_CHUNKS = 1e6;
/** 持久化文件名（位于 dataDir 下）。 */
const UPLOADS_FILE_NAME = "uploads.json";
/**
* 上传域错误。运行时 `code` 可能是 `TOO_MANY_UPLOADS`（契约文件不改，
* 继承 FileServiceError 以复用它的错误映射与 404/400 判定）。
*/
var UploadError = class extends FileServiceError {
	constructor(code, message, options) {
		super(code, message, options);
	}
};
/** 校验远端绝对路径并返回目录 / 文件名。 */
function splitRemotePath(remotePath) {
	if (typeof remotePath !== "string" || remotePath.length === 0) throw new UploadError("VALIDATION", "remotePath 不能为空");
	if (remotePath.includes("\0")) throw new UploadError("VALIDATION", "remotePath 含非法字符");
	if (!remotePath.startsWith("/")) throw new UploadError("VALIDATION", "remotePath 必须是绝对路径");
	if (remotePath.endsWith("/")) throw new UploadError("VALIDATION", "remotePath 必须指向文件，不能是目录");
	const name = basename$1(remotePath);
	if (name.length === 0 || name === "." || name === "..") throw new UploadError("VALIDATION", "remotePath 缺少合法文件名");
	return {
		dir: dirname$1(remotePath),
		name
	};
}
/** 校验分片大小。 */
function requireChunkSize(value, fallback) {
	if (value === void 0) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 67108864) throw new UploadError("VALIDATION", `chunkSize 必须是 1–${MAX_CHUNK_SIZE} 的整数`);
	return value;
}
/** 分片序号对应的字节区间。 */
function chunkSpan(index, chunkSize, totalBytes) {
	const offset = index * chunkSize;
	return {
		offset,
		length: Math.max(0, Math.min(chunkSize, totalBytes - offset))
	};
}
/** 持久化记录校验（损坏的条目直接丢弃）。 */
function parsePersisted(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const r = raw;
	if (typeof r.uploadId !== "string" || r.uploadId.length === 0) return void 0;
	if (typeof r.sessionId !== "string" || r.sessionId.length === 0) return void 0;
	if (typeof r.remotePath !== "string" || !r.remotePath.startsWith("/")) return void 0;
	if (typeof r.tempPath !== "string" || !r.tempPath.startsWith("/")) return void 0;
	if (typeof r.totalBytes !== "number" || !Number.isSafeInteger(r.totalBytes) || r.totalBytes <= 0) return void 0;
	if (typeof r.chunkSize !== "number" || !Number.isSafeInteger(r.chunkSize) || r.chunkSize <= 0 || r.chunkSize > 67108864) return void 0;
	if (typeof r.createdAtMs !== "number" || !Number.isFinite(r.createdAtMs)) return void 0;
	if (typeof r.expiresAtMs !== "number" || !Number.isFinite(r.expiresAtMs)) return void 0;
	const totalChunks = Math.ceil(r.totalBytes / r.chunkSize);
	if (totalChunks < 1 || totalChunks > 1e6) return void 0;
	if (!Array.isArray(r.receivedOffsets)) return void 0;
	const offsets = /* @__PURE__ */ new Set();
	for (const item of r.receivedOffsets) {
		if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item >= totalChunks) return void 0;
		offsets.add(item);
	}
	return {
		uploadId: r.uploadId,
		sessionId: r.sessionId,
		remotePath: r.remotePath,
		tempPath: r.tempPath,
		totalBytes: r.totalBytes,
		chunkSize: r.chunkSize,
		totalChunks,
		receivedOffsets: [...offsets].sort((a, b) => a - b),
		createdAtMs: r.createdAtMs,
		expiresAtMs: r.expiresAtMs
	};
}
/**
* 分片上传会话管理器。
* 所有公开方法先懒加载 uploads.json（host 重启后的断点续传），再清一次过期会话。
*/
var UploadSessionManager = class {
	getSftp;
	dataDir;
	defaultChunkSize;
	ttlMs;
	maxActiveUploads;
	now;
	writerFactory;
	uploads = /* @__PURE__ */ new Map();
	cleanupTimer;
	loaded = false;
	loading;
	persistChain = Promise.resolve();
	constructor(options) {
		this.getSftp = options.getSftp;
		this.dataDir = options.dataDir;
		this.defaultChunkSize = options.defaultChunkSize ?? 4194304;
		this.ttlMs = options.ttlMs ?? 36e5;
		this.maxActiveUploads = options.maxActiveUploads ?? 3;
		this.now = options.now ?? Date.now;
		this.writerFactory = options.writerFactory ?? ((sftp, path, mode) => SftpConcurrentWriter.open(sftp, path, { mode }));
		const intervalMs = options.cleanupIntervalMs ?? 6e4;
		if (intervalMs > 0) {
			this.cleanupTimer = setInterval(() => {
				this.purgeExpired().catch(() => {});
			}, intervalMs);
			this.cleanupTimer.unref?.();
		}
	}
	/** 当前活动上传数（含尚未完成的恢复记录）。 */
	get activeCount() {
		return this.uploads.size;
	}
	/** 创建上传：校验参数、打开远端临时文件写入句柄、返回分片计划。 */
	async create(input) {
		await this.ensureLoaded();
		await this.purgeExpired();
		if (typeof input.sessionId !== "string" || input.sessionId.length === 0) throw new UploadError("VALIDATION", "缺少 sessionId");
		const { dir, name } = splitRemotePath(input.remotePath);
		if (typeof input.totalBytes !== "number" || !Number.isSafeInteger(input.totalBytes) || input.totalBytes <= 0) throw new UploadError("VALIDATION", "totalBytes 必须是正整数");
		const chunkSize = requireChunkSize(input.chunkSize, this.defaultChunkSize);
		const totalChunks = Math.ceil(input.totalBytes / chunkSize);
		if (totalChunks > 1e6) throw new UploadError("VALIDATION", `分片数超过上限（${MAX_TOTAL_CHUNKS}）`);
		if (this.uploads.size >= this.maxActiveUploads) throw new UploadError("TOO_MANY_UPLOADS", `活动上传已达上限（${this.maxActiveUploads}），请先完成或取消其他上传`);
		const uploadId = randomUUID();
		const tempPath = `${dir === "/" ? "" : dir}/.dsh-tmp-${uploadId}-${name}`;
		const createdAtMs = this.now();
		const sftp = await this.getSftp(input.sessionId);
		const writer = await this.writerFactory(sftp, tempPath, "w", {});
		const record = {
			uploadId,
			sessionId: input.sessionId,
			remotePath: input.remotePath,
			tempPath,
			totalBytes: input.totalBytes,
			chunkSize,
			totalChunks,
			receivedOffsets: [],
			createdAtMs,
			expiresAtMs: createdAtMs + this.ttlMs,
			writer
		};
		this.uploads.set(uploadId, record);
		await this.persist();
		return {
			uploadId,
			tempPath,
			chunkSize,
			totalChunks
		};
	}
	/**
	* 写一个分片。分片可乱序、可重发；offset 缺省 = chunkIndex * chunkSize。
	* 分片长度必须精确等于该序号的应有长度（最后一片可短）。
	*/
	async writeChunk(uploadId, chunkIndex, buffer, offset) {
		await this.ensureLoaded();
		await this.purgeExpired();
		const record = this.requireActive(uploadId);
		if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= record.totalChunks) throw new UploadError("VALIDATION", `chunkIndex 越界（0–${record.totalChunks - 1}）`);
		const span = chunkSpan(chunkIndex, record.chunkSize, record.totalBytes);
		if (offset !== void 0 && offset !== span.offset) throw new UploadError("VALIDATION", "offset 与 chunkIndex 不匹配");
		if (!(buffer instanceof Uint8Array)) throw new UploadError("VALIDATION", "分片内容必须是二进制");
		const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		if (bytes.length !== span.length) throw new UploadError("VALIDATION", `分片大小不符（期望 ${span.length} 字节，实际 ${bytes.length}）`);
		await (await this.ensureWriter(record)).write(bytes, span.offset);
		if (!record.receivedOffsets.includes(chunkIndex)) {
			record.receivedOffsets.push(chunkIndex);
			record.receivedOffsets.sort((a, b) => a - b);
		}
		await this.persist();
		return {
			uploadId,
			chunkIndex,
			bytes: bytes.length
		};
	}
	/** 完成上传：校验分片无空洞 → 关句柄 → rename 落位 → 删记录。 */
	async complete(uploadId) {
		await this.ensureLoaded();
		await this.purgeExpired();
		const record = this.requireActive(uploadId);
		const received = new Set(record.receivedOffsets);
		const missing = [];
		for (let index = 0; index < record.totalChunks; index++) if (!received.has(index)) missing.push(index);
		if (missing.length > 0) throw new UploadError("VALIDATION", `分片不完整，缺少 ${missing.length} 片（首个: ${missing[0]}）`);
		const sftp = await this.getSftp(record.sessionId);
		if (typeof sftp.replace !== "function") throw new UploadError("UNSUPPORTED", "该 SFTP 门面不支持分片上传落位");
		const writer = record.writer;
		record.writer = void 0;
		if (writer !== void 0) await writer.close();
		try {
			await sftp.replace(record.tempPath, record.remotePath);
		} catch (error) {
			record.writer = void 0;
			throw error;
		}
		this.uploads.delete(uploadId);
		await this.persist();
		return {
			ok: true,
			bytes: record.totalBytes,
			remotePath: record.remotePath
		};
	}
	/** 查询状态（前端断点续传用）。 */
	async status(uploadId) {
		await this.ensureLoaded();
		await this.purgeExpired();
		const record = this.requireActive(uploadId);
		return {
			uploadId: record.uploadId,
			remotePath: record.remotePath,
			totalBytes: record.totalBytes,
			chunkSize: record.chunkSize,
			totalChunks: record.totalChunks,
			receivedOffsets: [...record.receivedOffsets],
			createdAtMs: record.createdAtMs,
			expiresAtMs: record.expiresAtMs
		};
	}
	/** 取消上传（幂等）：关句柄、尽力删临时文件、删记录。 */
	async cancel(uploadId) {
		await this.ensureLoaded();
		const record = this.uploads.get(uploadId);
		if (record === void 0) return { ok: true };
		await this.discard(record, true);
		await this.persist();
		return { ok: true };
	}
	/** 清理过期会话（定时器 / 启动后首次操作时调用）；返回清理数量。 */
	async purgeExpired() {
		await this.ensureLoaded();
		const at = this.now();
		const expired = [...this.uploads.values()].filter((record) => at >= record.expiresAtMs);
		for (const record of expired) await this.discard(record, true);
		if (expired.length > 0) await this.persist();
		return expired.length;
	}
	/** 卸载：停定时器、关全部句柄；不删临时文件（重启后仍可续传）。 */
	async closeAll() {
		if (this.cleanupTimer !== void 0) clearInterval(this.cleanupTimer);
		const writers = [];
		for (const record of this.uploads.values()) {
			if (record.writer !== void 0) writers.push(record.writer);
			record.writer = void 0;
		}
		this.uploads.clear();
		this.loaded = false;
		await Promise.all(writers.map((writer) => writer.close().catch(() => {})));
	}
	/** 懒加载持久化记录（并发调用合并）。 */
	async ensureLoaded() {
		if (this.loaded) return;
		if (this.loading !== void 0) {
			await this.loading;
			return;
		}
		this.loading = this.loadFromDisk();
		try {
			await this.loading;
		} finally {
			this.loading = void 0;
		}
	}
	/** 读 uploads.json；不存在 / 损坏时按空清单安全重建。 */
	async loadFromDisk() {
		this.loaded = true;
		let text;
		try {
			text = await readFile(join(this.dataDir, UPLOADS_FILE_NAME), "utf8");
		} catch {
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const envelope = parsed;
		if (envelope.version !== 1 || !Array.isArray(envelope.uploads)) return;
		const at = this.now();
		for (const raw of envelope.uploads) {
			const record = parsePersisted(raw);
			if (record === void 0) continue;
			if (at >= record.expiresAtMs) {
				this.discard(record, true);
				continue;
			}
			this.uploads.set(record.uploadId, record);
		}
	}
	/** 持久化（原子写；串行化避免并发 rename 互相覆盖）。失败不打断传输。 */
	persist() {
		this.persistChain = this.persistChain.then(async () => {
			const envelope = {
				version: 1,
				uploads: [...this.uploads.values()].map((record) => ({
					uploadId: record.uploadId,
					sessionId: record.sessionId,
					remotePath: record.remotePath,
					tempPath: record.tempPath,
					totalBytes: record.totalBytes,
					chunkSize: record.chunkSize,
					totalChunks: record.totalChunks,
					receivedOffsets: [...record.receivedOffsets],
					createdAtMs: record.createdAtMs,
					expiresAtMs: record.expiresAtMs
				}))
			};
			try {
				await mkdir(this.dataDir, { recursive: true });
				const target = join(this.dataDir, UPLOADS_FILE_NAME);
				const temp = `${target}.${process.pid}.tmp`;
				await writeFile(temp, JSON.stringify(envelope), "utf8");
				await rename(temp, target);
			} catch {}
		});
		return this.persistChain;
	}
	/** 取一个未过期记录；不存在 / 过期 → NOT_FOUND。 */
	requireActive(uploadId) {
		const record = this.uploads.get(uploadId);
		if (record === void 0) throw new UploadError("NOT_FOUND", "上传会话不存在");
		if (this.now() >= record.expiresAtMs) {
			this.discard(record, true);
			throw new UploadError("NOT_FOUND", "上传会话已过期");
		}
		return record;
	}
	/** 懒打开 / 重开写入句柄；远端临时文件不在则从头开始。 */
	async ensureWriter(record) {
		if (record.writer !== void 0 && !record.writer.props.poisoned) return record.writer;
		if (record.writer !== void 0) {
			const stale = record.writer;
			record.writer = void 0;
			await stale.close().catch(() => {});
		}
		const sftp = await this.getSftp(record.sessionId);
		let mode = "r+";
		try {
			if (!(await sftp.stat(record.tempPath)).isFile) {
				mode = "w";
				record.receivedOffsets = [];
			}
		} catch (error) {
			if (error instanceof FileServiceError && error.code === "NOT_FOUND") {
				mode = "w";
				record.receivedOffsets = [];
			} else throw error;
		}
		record.writer = await this.writerFactory(sftp, record.tempPath, mode, {});
		return record.writer;
	}
	/** 关句柄（若打开）、删记录、可选删临时文件。 */
	async discard(record, removeTemp) {
		const writer = record.writer;
		record.writer = void 0;
		this.uploads.delete(record.uploadId);
		if (writer !== void 0) await writer.close().catch(() => {});
		if (!removeTemp) return;
		try {
			await (await this.getSftp(record.sessionId)).unlink?.(record.tempPath);
		} catch {}
	}
};
//#endregion
//#region src/remotes.ts
function requireFiles(deps) {
	if (deps.files === void 0) throw new FileServiceError("UNSUPPORTED", "文件服务未启用");
	return deps.files;
}
/** 把领域异常折叠成 RpcResult 的错误分支（code 编进 message，M4 可细化）。 */
function toError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return {
		code: "internal",
		message: `${error instanceof Error && "code" in error ? String(error.code) : "INTERNAL"}: ${message}`,
		details: {}
	};
}
function ok(value) {
	return {
		ok: true,
		value
	};
}
/**
* 纯调度：按 endpoint 名分发，返回 RpcResult。不依赖 ctx，便于直接测试。
*/
async function dispatch(endpoint, payload, deps, signal) {
	if (signal.aborted) return {
		ok: false,
		error: {
			code: "cancelled",
			message: "已取消",
			details: {}
		}
	};
	try {
		await deps.store.ensureLoaded();
		switch (endpoint) {
			case "connections.list": return ok(deps.store.list());
			case "connections.create": return ok(await deps.store.create(payload));
			case "connections.update": {
				const { id, patch } = payload;
				return ok(await deps.store.update(id, patch));
			}
			case "connections.remove": {
				const { id } = payload;
				await deps.store.remove(id);
				return ok({ id });
			}
			case "sessions.list": return ok(deps.sessions.list());
			case "connections.probe": {
				const { ids } = payload;
				return ok(await deps.sessions.probeAll(ids));
			}
			case "sessions.connect": {
				const { connId, protocol, host, port, username, password, privateKey, passphrase, label, telnetMode, connectTimeoutMs, newline, localEcho } = payload;
				const auth = password !== void 0 ? {
					kind: "password",
					password
				} : privateKey !== void 0 ? {
					kind: "key",
					privateKey,
					...passphrase !== void 0 ? { passphrase } : {}
				} : void 0;
				return ok(connId !== void 0 && connId.length > 0 ? await deps.sessions.connectByConnId(connId) : await deps.sessions.connect({
					protocol: protocol ?? "telnet",
					host: host ?? "127.0.0.1",
					port: port ?? 23,
					...username !== void 0 ? { username } : {},
					...auth !== void 0 ? { auth } : {},
					...label !== void 0 ? { label } : {},
					...telnetMode !== void 0 ? { telnetMode } : {},
					...connectTimeoutMs !== void 0 ? { connectTimeoutMs } : {},
					...newline !== void 0 ? { newline } : {},
					...localEcho !== void 0 ? { localEcho } : {}
				}));
			}
			case "sessions.disconnect": {
				const { sessionId } = payload;
				await deps.sessions.disconnect(sessionId);
				return ok({ sessionId });
			}
			case "sessions.reconnect": {
				const { sessionId } = payload;
				return ok(await deps.sessions.reconnect(sessionId));
			}
			case "sessions.read": {
				const { sessionId, count } = payload;
				return ok(deps.sessions.read(sessionId, count));
			}
			case "sessions.send": {
				const { sessionId, command, source, wait, newline, submit } = payload;
				return ok(await deps.sessions.sendAndWait(sessionId, command, {
					source: source ?? "script",
					...wait !== void 0 ? { wait } : {},
					...newline !== void 0 ? { newline } : {},
					...submit !== void 0 ? { submit } : {},
					signal
				}));
			}
			case "tm_keyboard_mode": {
				const { action, sessionId, backspace, delete: del } = payload;
				if (action === "set") {
					const mode = deps.sessions.setKeyboardMode(sessionId, {
						...backspace !== void 0 ? { backspaceByte: backspace } : {},
						...del !== void 0 ? { deleteByte: del } : {}
					});
					return ok({
						backspace: mode.backspaceByte,
						delete: mode.deleteByte
					});
				}
				const mode = deps.sessions.getKeyboardMode(sessionId);
				return ok({
					backspace: mode.backspaceByte,
					delete: mode.deleteByte
				});
			}
			case "files.tree": {
				const ref = payload;
				return ok(await requireFiles(deps).listLocal(ref));
			}
			case "files.read": {
				const { root, path, maxBytes } = payload;
				return ok(await requireFiles(deps).readLocal({
					root,
					path
				}, maxBytes !== void 0 ? { maxBytes } : {}));
			}
			case "files.write": {
				const { root, path, content } = payload;
				if (typeof content !== "string") throw new FileServiceError("VALIDATION", "content 必须是字符串");
				return ok(await requireFiles(deps).writeLocal({
					root,
					path
				}, content));
			}
			case "files.dirs": {
				const { path } = payload;
				return ok(await requireFiles(deps).listDirectories(path));
			}
			case "files.root": return ok({
				root: deps.config?.workspaceRoot ?? process.cwd(),
				...deps.localPanel !== void 0 && deps.localPanel.cwd.length > 0 ? {
					localCwd: deps.localPanel.cwd,
					localRoot: deps.localPanel.root
				} : {}
			});
			case "files.setLocalPanel": {
				const { root, cwd } = payload;
				if (deps.localPanel !== void 0) {
					deps.localPanel.root = root;
					deps.localPanel.cwd = cwd;
				}
				return ok({});
			}
			case "files.open": {
				const { root, path } = payload;
				if (deps.openExternal === void 0) throw new FileServiceError("UNSUPPORTED", "系统程序打开未启用");
				const real = await resolveInsideRoot(root, path);
				if (!(await stat(real).catch((e) => {
					throw mapFsError(e, "文件");
				})).isFile()) throw new FileServiceError("VALIDATION", "只能打开文件，不能打开目录");
				await deps.openExternal(real);
				return ok({ path: real });
			}
			case "files.remoteTree": {
				const { sessionId, path } = payload;
				return ok(await requireFiles(deps).listRemote({
					sessionId,
					path
				}));
			}
			case "files.remoteCwd": {
				const { sessionId } = payload;
				return ok(await requireFiles(deps).remoteCwd({ sessionId }));
			}
			case "files.downloadToLocal": {
				const { sessionId, remotePath, root, path, transferId } = payload;
				const id = transferIdOf(transferId);
				try {
					const result = await requireFiles(deps).downloadToLocal({
						sessionId,
						remotePath,
						target: {
							root,
							path
						},
						onProgress: (p) => deps.broadcastFileProgress?.({
							kind: "file-progress",
							transferId: id,
							...p
						})
					});
					deps.broadcastFileProgress?.({
						kind: "file-progress",
						transferId: id,
						op: "download",
						sessionId,
						remotePath,
						transferred: result.bytes,
						done: true,
						ok: true
					});
					return ok({
						...result,
						transferId: id
					});
				} catch (error) {
					deps.broadcastFileProgress?.({
						kind: "file-progress",
						transferId: id,
						op: "download",
						sessionId,
						remotePath,
						transferred: 0,
						done: true,
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					});
					throw error;
				}
			}
			case "files.uploadLocal": {
				const { sessionId, remotePath, root, path, transferId } = payload;
				const id = transferIdOf(transferId);
				try {
					const result = await requireFiles(deps).upload({
						sessionId,
						remotePath,
						source: {
							kind: "local",
							ref: {
								root,
								path
							}
						},
						onProgress: (p) => deps.broadcastFileProgress?.({
							kind: "file-progress",
							transferId: id,
							...p
						})
					});
					deps.broadcastFileProgress?.({
						kind: "file-progress",
						transferId: id,
						op: "upload",
						sessionId,
						remotePath,
						transferred: result.bytes,
						done: true,
						ok: true
					});
					return ok({
						...result,
						transferId: id
					});
				} catch (error) {
					deps.broadcastFileProgress?.({
						kind: "file-progress",
						transferId: id,
						op: "upload",
						sessionId,
						remotePath,
						transferred: 0,
						done: true,
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					});
					throw error;
				}
			}
			default: return {
				ok: false,
				error: {
					code: "internal",
					message: `未知方法: ${endpoint}`,
					details: {}
				}
			};
		}
	} catch (error) {
		if (signal.aborted) return {
			ok: false,
			error: {
				code: "cancelled",
				message: "已取消",
				details: {}
			}
		};
		return {
			ok: false,
			error: toError(error)
		};
	}
}
/** 前端生成的传输关联 id（不透明回显，≤64 字符；缺省时服务端生成）。 */
function transferIdOf(raw) {
	const id = (raw ?? "").trim();
	if (id.length > 64) throw new FileServiceError("VALIDATION", "transferId 过长（上限 64 字符）");
	return id.length > 0 ? id : randomUUID();
}
/** 传输路由的公共查询参数校验（upload / download 共用）。 */
function transferQueryOf(url) {
	const sessionId = url.searchParams.get("sessionId") ?? "";
	const remotePath = url.searchParams.get("remotePath") ?? "";
	if (sessionId.length === 0) throw new FileServiceError("VALIDATION", "缺少 sessionId");
	if (remotePath.length === 0) throw new FileServiceError("VALIDATION", "缺少 remotePath");
	return {
		sessionId,
		remotePath,
		transferId: transferIdOf(url.searchParams.get("transferId"))
	};
}
/** 传输路由的错误响应：NOT_FOUND → 404，其余 → 400（body 仍带错误码，前端按 code 展示）。 */
function transferErrorStatus(error) {
	return error instanceof FileServiceError && error.code === "NOT_FOUND" ? 404 : 400;
}
/** 失败路径上尽量还原查询参数（校验失败时字段可能缺失，回显空串即可）。 */
function safeQueryOf(url) {
	const sessionId = url.searchParams.get("sessionId") ?? "";
	const remotePath = url.searchParams.get("remotePath") ?? "";
	const raw = url.searchParams.get("transferId") ?? "";
	return {
		sessionId,
		remotePath,
		transferId: raw.length > 0 && raw.length <= 64 ? raw : ""
	};
}
/** 传输路由的错误响应（Fetch 形态，已过 Connection 认证）。 */
function transferErrorResponse(error) {
	return Response.json({
		ok: false,
		error: toError(error)
	}, { status: transferErrorStatus(error) });
}
/** 取分片上传会话管理器；未装配 → UNSUPPORTED。 */
function requireUploads(deps) {
	if (deps.uploads === void 0) throw new FileServiceError("UNSUPPORTED", "分片上传未启用");
	return deps.uploads;
}
/** 读 JSON 对象请求体；非对象 / 非法 JSON → VALIDATION。 */
async function readJsonObject(request) {
	let body;
	try {
		body = await request.json();
	} catch {
		throw new FileServiceError("VALIDATION", "请求体不是合法 JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new FileServiceError("VALIDATION", "请求体必须是 JSON 对象");
	return body;
}
/** 读原始字节请求体（有上限，超过即取消读取）；空 body → VALIDATION。 */
async function readBodyBytes(request, maxBytes) {
	if (request.body === null) throw new FileServiceError("VALIDATION", "缺少分片内容");
	const reader = request.body.getReader();
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new FileServiceError("VALIDATION", `分片超过上限（${maxBytes} 字节）`);
		}
		chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
	}
	return Buffer.concat(chunks, total);
}
/** POST /api/term-manager/files/upload/chunked/create：JSON → 分片计划。 */
function createChunkedCreateFetch(deps) {
	return async (request) => {
		try {
			const body = await readJsonObject(request);
			const value = await requireUploads(deps).create({
				sessionId: body.sessionId,
				remotePath: body.remotePath,
				totalBytes: body.totalBytes,
				...body.chunkSize !== void 0 ? { chunkSize: body.chunkSize } : {}
			});
			return Response.json({
				ok: true,
				value
			});
		} catch (error) {
			return transferErrorResponse(error);
		}
	};
}
/** POST /api/term-manager/files/upload/chunked/chunk?uploadId&chunkIndex：raw 分片字节。 */
function createChunkedChunkFetch(deps) {
	return async (request) => {
		try {
			const url = new URL(request.url);
			const uploadId = url.searchParams.get("uploadId") ?? "";
			if (uploadId.length === 0) throw new FileServiceError("VALIDATION", "缺少 uploadId");
			const rawIndex = url.searchParams.get("chunkIndex");
			const chunkIndex = rawIndex === null || rawIndex.trim().length === 0 ? NaN : Number(rawIndex);
			if (!Number.isInteger(chunkIndex) || chunkIndex < 0) throw new FileServiceError("VALIDATION", "缺少或非法的 chunkIndex");
			const bytes = await readBodyBytes(request, MAX_CHUNK_SIZE);
			const value = await requireUploads(deps).writeChunk(uploadId, chunkIndex, bytes);
			return Response.json({
				ok: true,
				value
			});
		} catch (error) {
			return transferErrorResponse(error);
		}
	};
}
/** POST /api/term-manager/files/upload/chunked/complete：JSON { uploadId }。 */
function createChunkedCompleteFetch(deps) {
	return async (request) => {
		try {
			const uploadId = (await readJsonObject(request)).uploadId;
			if (typeof uploadId !== "string" || uploadId.length === 0) throw new FileServiceError("VALIDATION", "缺少 uploadId");
			const value = await requireUploads(deps).complete(uploadId);
			return Response.json({
				ok: true,
				value
			});
		} catch (error) {
			return transferErrorResponse(error);
		}
	};
}
/** GET /api/term-manager/files/upload/chunked/status?uploadId：断点续传查询。 */
function createChunkedStatusFetch(deps) {
	return async (request) => {
		try {
			const uploadId = new URL(request.url).searchParams.get("uploadId") ?? "";
			if (uploadId.length === 0) throw new FileServiceError("VALIDATION", "缺少 uploadId");
			const value = await requireUploads(deps).status(uploadId);
			return Response.json({
				ok: true,
				value
			});
		} catch (error) {
			return transferErrorResponse(error);
		}
	};
}
/** POST /api/term-manager/files/upload/chunked/cancel：JSON { uploadId }（幂等）。 */
function createChunkedCancelFetch(deps) {
	return async (request) => {
		try {
			const uploadId = (await readJsonObject(request)).uploadId;
			if (typeof uploadId !== "string" || uploadId.length === 0) throw new FileServiceError("VALIDATION", "缺少 uploadId");
			const value = await requireUploads(deps).cancel(uploadId);
			return Response.json({
				ok: true,
				value
			});
		} catch (error) {
			return transferErrorResponse(error);
		}
	};
}
/**
* POST /api/term-manager/files/upload —— 浏览器直传（raw 二进制）。
* Connection 的 streaming 路由把 Request.body 原样交给 FileService（SFTP 远端带临时文件 + rename
* 半成品保护），不把 body 读成字符串。进度经 WS file-progress 帧广播；HTTP 响应 settle 为准（双保险）。
*/
function createUploadFetch(deps) {
	return async (request) => {
		const url = new URL(request.url);
		try {
			const { sessionId, remotePath, transferId } = transferQueryOf(url);
			const rawLength = request.headers.get("content-length");
			const contentLength = rawLength === null ? NaN : Number(rawLength);
			const size = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : void 0;
			if (request.body === null) throw new FileServiceError("VALIDATION", "缺少上传内容");
			const result = await requireFiles(deps).upload({
				sessionId,
				remotePath,
				source: {
					kind: "stream",
					stream: Readable.fromWeb(request.body),
					...size !== void 0 ? { size } : {}
				},
				onProgress: (p) => deps.broadcastFileProgress?.({
					kind: "file-progress",
					transferId,
					...p
				})
			});
			deps.broadcastFileProgress?.({
				kind: "file-progress",
				transferId,
				op: "upload",
				sessionId,
				remotePath,
				transferred: result.bytes,
				done: true,
				ok: true
			});
			return Response.json({
				ok: true,
				value: {
					...result,
					transferId
				}
			});
		} catch (error) {
			const { sessionId, remotePath, transferId } = safeQueryOf(url);
			deps.broadcastFileProgress?.({
				kind: "file-progress",
				transferId,
				op: "upload",
				sessionId,
				remotePath,
				transferred: 0,
				done: true,
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
			return transferErrorResponse(error);
		}
	};
}
/**
* GET /api/term-manager/files/download —— 浏览器另存为（导航式下载，可选任意本机目录）。
* 前置 stat 在 FileService.download 里完成（不存在 → 进 404 分支，头未发）；
* 文件名 RFC 5987 编码支持中文；no-store 防缓存。终态帧是前端唯一的完成/失败信号。
*/
function createDownloadFetch(deps) {
	return async (request) => {
		const url = new URL(request.url);
		try {
			const { sessionId, remotePath, transferId } = transferQueryOf(url);
			let transferred = 0;
			const { stream, size } = await requireFiles(deps).download({
				sessionId,
				remotePath,
				onProgress: (p) => {
					transferred = p.transferred;
					deps.broadcastFileProgress?.({
						kind: "file-progress",
						transferId,
						...p
					});
				}
			});
			const filename = basename$1(remotePath) || "download";
			const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
			const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
			const body = Readable.toWeb(stream);
			stream.once("end", () => {
				deps.broadcastFileProgress?.({
					kind: "file-progress",
					transferId,
					op: "download",
					sessionId,
					remotePath,
					transferred,
					done: true,
					ok: true
				});
			});
			stream.once("error", (error) => {
				deps.broadcastFileProgress?.({
					kind: "file-progress",
					transferId,
					op: "download",
					sessionId,
					remotePath,
					transferred,
					done: true,
					ok: false,
					error: error.message
				});
			});
			return new Response(body, {
				status: 200,
				headers: {
					"content-type": "application/octet-stream",
					...size !== void 0 ? { "content-length": String(size) } : {},
					"content-disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
					"cache-control": "no-store"
				}
			});
		} catch (error) {
			const { sessionId, remotePath, transferId } = safeQueryOf(url);
			deps.broadcastFileProgress?.({
				kind: "file-progress",
				transferId,
				op: "download",
				sessionId,
				remotePath,
				transferred: 0,
				done: true,
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
			return transferErrorResponse(error);
		}
	};
}
/** 本插件的控制面方法全集（每个方法注册一条 /api 下的精确 Fetch 路由）。 */
const TERM_MANAGER_METHODS = [
	"connections.list",
	"connections.create",
	"connections.update",
	"connections.remove",
	"connections.probe",
	"sessions.list",
	"sessions.connect",
	"sessions.disconnect",
	"sessions.reconnect",
	"sessions.read",
	"sessions.send",
	"tm_keyboard_mode",
	"files.tree",
	"files.read",
	"files.write",
	"files.dirs",
	"files.root",
	"files.setLocalPanel",
	"files.open",
	"files.remoteTree",
	"files.remoteCwd",
	"files.downloadToLocal",
	"files.uploadLocal"
];
/**
* 一条 RPC 精确 Fetch 路由：`POST /api/term-manager/<method>`。
* 精确路由在 Typert Gateway interceptor 之前命中，因此可用 /api 的统一认证；
* 认证、Host/Origin 栅栏由 Connection 负责（精确路由只放行 owner Peer）。
*/
function createRpcFetch(deps, method) {
	return async (request) => {
		let rpcId = "invalid";
		let payload = {};
		try {
			const body = await request.json();
			if (typeof body.rpcId === "string") rpcId = body.rpcId;
			payload = body.payload ?? {};
		} catch {
			return Response.json({
				type: "server-response",
				rpcId,
				result: {
					ok: false,
					error: {
						code: "internal",
						message: "invalid JSON",
						details: {}
					}
				}
			}, { status: 400 });
		}
		const result = await dispatch(method, payload, deps, request.signal);
		return Response.json({
			type: "server-response",
			rpcId,
			result
		});
	};
}
/**
* 把控制面挂到 DSH 统一认证的 /api 下。
* 为什么用精确 Fetch 路由而不是 Typert/`connection.rpc.handle`：
* - `/api` 的 Typert Gateway 只允许一个 interceptor，外部插件不能另注册；
* - 0.2.1 的 `connection.rpc.handle` 在服务自身 ctx 上注册 webServer 路由，外部插件调用会报
*   “cannot get property webServer without inject”；
* - 精确 Fetch 路由是 DSH 文档给外部插件的受支持路径，且在 Gateway interceptor 之前命中。
* 认证、Host/Origin 栅栏都由 Connection 负责，插件不再自建 CORS/loopback 判断。
*/
function registerRemotes(ctx, deps) {
	const connection = ctx.get("connection");
	if (connection === void 0) {
		console.warn("[term-manager] connection 服务不可用，remotes 未挂载");
		return () => {};
	}
	const disposers = [];
	for (const method of TERM_MANAGER_METHODS) disposers.push(connection.fetch.register({
		path: `/api/term-manager/${method}`,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: createRpcFetch(deps, method)
	}));
	disposers.push(connection.fetch.register({
		path: "/api/term-manager/files/upload",
		methods: ["POST"],
		requestBody: "streaming",
		fetch: createUploadFetch(deps)
	}));
	disposers.push(connection.fetch.register({
		path: "/api/term-manager/files/download",
		methods: ["GET"],
		requestBody: "buffered",
		fetch: createDownloadFetch(deps)
	}));
	disposers.push(connection.fetch.register({
		path: "/api/term-manager/files/upload/chunked/create",
		methods: ["POST"],
		requestBody: "buffered",
		fetch: createChunkedCreateFetch(deps)
	}));
	disposers.push(connection.fetch.register({
		path: "/api/term-manager/files/upload/chunked/chunk",
		methods: ["POST"],
		requestBody: "streaming",
		fetch: createChunkedChunkFetch(deps)
	}));
	disposers.push(connection.fetch.register({
		path: "/api/term-manager/files/upload/chunked/complete",
		methods: ["POST"],
		requestBody: "buffered",
		fetch: createChunkedCompleteFetch(deps)
	}));
	disposers.push(connection.fetch.register({
		path: "/api/term-manager/files/upload/chunked/status",
		methods: ["GET"],
		requestBody: "buffered",
		fetch: createChunkedStatusFetch(deps)
	}));
	disposers.push(connection.fetch.register({
		path: "/api/term-manager/files/upload/chunked/cancel",
		methods: ["POST"],
		requestBody: "buffered",
		fetch: createChunkedCancelFetch(deps)
	}));
	const disposeAll = () => {
		Promise.all(disposers.map((dispose) => dispose()));
	};
	ctx.effect(() => disposeAll, "terminal-manager: /api 控制面路由");
	return disposeAll;
}
//#endregion
//#region src/command-guard.ts
/** 默认黑名单：典型破坏性命令（可按部署扩充）。 */
const DEFAULT_DANGEROUS_RULES = [
	{
		pattern: "\\brm\\s+(-[a-z]+\\s+)*(/|/\\*|~|\\$HOME)\\s*(?:[;&|]|$)",
		why: "递归删除根目录/主目录"
	},
	{
		pattern: "\\brm\\s+[^|;&]*-[a-z]*r[a-z]*",
		why: "递归删除（含 -r 标志）"
	},
	{
		pattern: "\\bmkfs(\\.[a-z0-9]+)?\\b",
		why: "格式化文件系统"
	},
	{
		pattern: "\\bdd\\b[^|;&]*\\bof=/dev/",
		why: "对磁盘设备低层写入"
	},
	{
		pattern: "\\b(shutdown|reboot|halt|poweroff)\\b",
		why: "关机/重启设备"
	},
	{
		pattern: "\\binit\\s+0\\b",
		why: "关机"
	},
	{
		pattern: ":\\(\\)\\s*\\{",
		why: "fork 炸弹"
	}
];
/** 检查一条命令。白名单优先；黑名单命中返回 block + 原因。 */
function checkCommand(command, options = {}) {
	if (options.whitelist !== void 0) {
		for (const source of options.whitelist) if (new RegExp(source, "i").test(command)) return { verdict: "allow" };
	}
	const rules = [...DEFAULT_DANGEROUS_RULES, ...options.extraRules ?? []];
	for (const rule of rules) if (new RegExp(rule.pattern, "i").test(command)) return {
		verdict: "block",
		rule
	};
	return { verdict: "allow" };
}
//#endregion
//#region src/event-bus.ts
function matches(filter, event) {
	if (filter === void 0) return true;
	if (filter.sessionId !== void 0 && event.sessionId !== filter.sessionId) return false;
	if (filter.type !== void 0) {
		if (!(typeof filter.type === "string" ? [filter.type] : filter.type).includes(event.type)) return false;
	}
	return true;
}
/** 新建一条事件总线。 */
function createEventBus() {
	const subs = /* @__PURE__ */ new Set();
	return {
		emit(event) {
			for (const sub of [...subs]) {
				if (!matches(sub.filter, event)) continue;
				try {
					sub.handler(event);
				} catch (error) {
					console.error("[terminal-manager] 事件订阅者抛错（已忽略）:", error);
				}
			}
		},
		on(handler, filter) {
			const sub = {
				handler,
				filter
			};
			subs.add(sub);
			return () => {
				subs.delete(sub);
			};
		}
	};
}
//#endregion
//#region src/transport/sftp.ts
/**
* SFTP 门面 —— 把 ssh2 的 SFTPWrapper 包装成文件服务远端操作需要的原语：
* list / stat / mkdirs / put / get / downloadStream。
* 上传统一先写远端临时文件（`<目标>.tm-partial-<rand>`）再改名：成功才落地，中断 / 失败自动清理半成品。
* 进度回调节流 200ms，传输结束补发一次终值。
* 所有错误统一映射为 FileServiceError（见 mapSftpError）。
* @module dsh-terminal-manager/transport/sftp
*/
const { STATUS_CODE, OPEN_MODE } = ssh2.utils.sftp;
const PROGRESS_THROTTLE_MS = 200;
/**
* ssh2 SFTP 错误 → 统一错误码：
* NO_SUCH_FILE → NOT_FOUND；PERMISSION_DENIED → VALIDATION；
* NO_CONNECTION / CONNECTION_LOST（连接已断）→ DISCONNECTED；其余 → REMOTE_IO。
* FileServiceError 原样透传。message 只描述问题，不含凭据。
*/
function mapSftpError(err, what) {
	if (err instanceof FileServiceError) return err;
	const code = err?.code;
	const message = err instanceof Error ? err.message : String(err);
	if (code === STATUS_CODE.NO_SUCH_FILE) return new FileServiceError("NOT_FOUND", `${what}不存在`, { cause: err });
	if (code === STATUS_CODE.PERMISSION_DENIED) return new FileServiceError("VALIDATION", `${what}没有访问权限`, { cause: err });
	if (code === STATUS_CODE.NO_CONNECTION || code === STATUS_CODE.CONNECTION_LOST || /not connected/i.test(message)) return new FileServiceError("DISCONNECTED", `SSH 连接已断开，${what}无法继续`, { cause: err });
	return new FileServiceError("REMOTE_IO", `${what}失败: ${message}`, { cause: err });
}
/** 节流包装：至少间隔 PROGRESS_THROTTLE_MS 才透传一次（首值立即透传；终值由调用方补发） */
function throttleProgress(onProgress) {
	if (!onProgress) return void 0;
	let last = 0;
	return (transferred, total) => {
		const now = Date.now();
		if (now - last >= PROGRESS_THROTTLE_MS) {
			last = now;
			onProgress(transferred, total);
		}
	};
}
/** 远端路径拼接（SFTP 统一 POSIX 斜杠风格） */
function joinRemote(dir, name) {
	return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
var SftpFacade = class {
	sftp;
	constructor(sftp) {
		this.sftp = sftp;
	}
	/** 列一层目录（属性按 readdir 返回，符号链接不跟随） */
	list(path) {
		return new Promise((resolve, reject) => {
			this.sftp.readdir(path, (err, infos) => {
				if (err) {
					reject(mapSftpError(err, `列目录 ${path}`));
					return;
				}
				resolve(infos.map((fi) => {
					const kind = fi.attrs.isDirectory() ? "dir" : fi.attrs.isSymbolicLink() ? "symlink" : fi.attrs.isFile() ? "file" : "other";
					return {
						name: fi.filename,
						path: joinRemote(path, fi.filename),
						kind,
						...typeof fi.attrs.size === "number" ? { size: fi.attrs.size } : {},
						...typeof fi.attrs.mtime === "number" ? { mtimeMs: fi.attrs.mtime * 1e3 } : {}
					};
				}));
			});
		});
	}
	/** 解析路径为绝对路径（'.' = 终端当前目录） */
	realpath(path) {
		return new Promise((resolve, reject) => {
			this.sftp.realpath(path, (err, absPath) => {
				if (err) {
					reject(mapSftpError(err, `解析路径 ${path}`));
					return;
				}
				resolve(absPath);
			});
		});
	}
	/** 单个路径的信息（lstat 语义） */
	stat(path) {
		return new Promise((resolve, reject) => {
			this.sftp.lstat(path, (err, st) => {
				if (err) {
					reject(mapSftpError(err, `读取信息 ${path}`));
					return;
				}
				resolve({
					isDirectory: st.isDirectory(),
					isFile: st.isFile(),
					isSymlink: st.isSymbolicLink(),
					...typeof st.size === "number" ? { size: st.size } : {},
					...typeof st.mtime === "number" ? { mtimeMs: st.mtime * 1e3 } : {}
				});
			});
		});
	}
	/** 逐级建目录（已存在且是目录则跳过；中间有同名非目录则 REMOTE_IO） */
	async mkdirs(path) {
		const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
		if (!norm) throw new FileServiceError("VALIDATION", "远端目录路径不能为空");
		if (norm === "/") return;
		let cur = "";
		for (const part of norm.split("/")) {
			cur += `/${part}`;
			let st;
			try {
				st = await this.statFollowed(cur);
			} catch (err) {
				if (err.code !== "NOT_FOUND") throw err;
			}
			if (st) {
				if (!st.isDirectory) throw new FileServiceError("REMOTE_IO", `${cur}已存在且不是目录`);
				continue;
			}
			await new Promise((resolve, reject) => {
				this.sftp.mkdir(cur, (err) => err ? reject(mapSftpError(err, `创建目录 ${cur}`)) : resolve());
			});
		}
	}
	/**
	* 上传：先写远端临时文件 `<目标>.tm-partial-<rand>`，成功后改名到目标；
	* 中断 / 失败清理临时文件（半成品），目标上的旧文件不受影响。
	* 目标已存在时覆盖（同名冲突由上层 UI 先问过用户）。
	*/
	async put(source, remotePath, opts = {}) {
		if (!remotePath || remotePath.includes("\0")) throw new FileServiceError("VALIDATION", "远端路径不能为空");
		const temp = `${remotePath}.tm-partial-${randomBytes(4).toString("hex")}`;
		try {
			const bytes = source.kind === "path" ? await this.fastPutToTemp(source.path, temp, opts.onProgress) : await this.pumpStreamToTemp(source.stream, temp, source.size, opts.onProgress);
			await this.place(temp, remotePath);
			return { bytes };
		} catch (err) {
			await this.unlinkQuietly(temp);
			throw mapSftpError(err, `上传 ${remotePath}`);
		}
	}
	/** 下载到本地路径（fastGet）。maxBytes 超限抛 FILE_TOO_LARGE */
	async get(remotePath, localPath, opts = {}) {
		const size = await this.requireFileSize(remotePath, opts.maxBytes);
		const throttled = throttleProgress(opts.onProgress);
		let transferred = 0;
		await new Promise((resolve, reject) => {
			this.sftp.fastGet(remotePath, localPath, { step: (done) => {
				transferred = done;
				throttled?.(done, size);
			} }, (err) => err ? reject(mapSftpError(err, `下载 ${remotePath}`)) : resolve());
		});
		opts.onProgress?.(transferred, size);
		return {
			bytes: transferred,
			size
		};
	}
	/** 下载成流（HTTP 路由直接管响应）。错误经 destroy 传播到返回的流上 */
	async downloadStream(remotePath, opts = {}) {
		const size = await this.requireFileSize(remotePath, opts.maxBytes);
		const throttled = throttleProgress(opts.onProgress);
		let transferred = 0;
		const out = new PassThrough();
		const rs = this.sftp.createReadStream(remotePath);
		rs.on("data", (chunk) => {
			transferred += chunk.length;
			throttled?.(transferred, size);
		});
		rs.on("end", () => opts.onProgress?.(transferred, size));
		rs.on("error", (err) => out.destroy(mapSftpError(err, `下载 ${remotePath}`)));
		out.on("close", () => {
			if (!rs.readableEnded) rs.destroy();
		});
		rs.pipe(out);
		return {
			stream: out,
			...size !== void 0 ? { size } : {}
		};
	}
	/**
	* 打开随机写句柄（分片上传）。'w' 截断新建；'r+' 保留已写内容（host 重启后续传）。
	* ssh2 的 write 是 position-based，多个子包可并发写同一句柄。
	*/
	openWrite(path, mode = "w") {
		return new Promise((resolve, reject) => {
			this.sftp.open(path, mode, (err, handle) => {
				if (err) {
					reject(mapSftpError(err, `打开写入文件 ${path}`));
					return;
				}
				let closed = false;
				resolve({
					write: (buffer, position) => new Promise((done, fail) => {
						this.sftp.write(handle, buffer, 0, buffer.length, position, (writeErr) => {
							if (writeErr) fail(mapSftpError(writeErr, `写入 ${path}`));
							else done();
						});
					}),
					close: () => new Promise((done) => {
						if (closed) {
							done();
							return;
						}
						closed = true;
						this.sftp.close(handle, () => done());
					})
				});
			});
		});
	}
	/** 原子落位（rename 覆盖语义，与 put 的临时文件落位一致） */
	async replace(from, to) {
		try {
			await this.place(from, to);
		} catch (err) {
			throw mapSftpError(err, `落位 ${to}`);
		}
	}
	/** 删除远端文件（不存在也算成功；其余错误映射后抛出） */
	async unlink(path) {
		await new Promise((resolve, reject) => {
			this.sftp.unlink(path, (err) => {
				if (err === void 0 || err === null) {
					resolve();
					return;
				}
				if (err.code === STATUS_CODE.NO_SUCH_FILE) {
					resolve();
					return;
				}
				reject(mapSftpError(err, `删除 ${path}`));
			});
		});
	}
	/** stat（跟随符号链接；mkdirs 探测用） */
	statFollowed(path) {
		return new Promise((resolve, reject) => {
			this.sftp.stat(path, (err, st) => {
				if (err) {
					reject(mapSftpError(err, `读取信息 ${path}`));
					return;
				}
				resolve({
					isDirectory: st.isDirectory(),
					isFile: st.isFile(),
					isSymlink: st.isSymbolicLink(),
					...typeof st.size === "number" ? { size: st.size } : {}
				});
			});
		});
	}
	/** 先 stat 校验存在性与大小上限，返回已知大小 */
	async requireFileSize(remotePath, maxBytes) {
		const st = await this.stat(remotePath);
		if (st.isDirectory) throw new FileServiceError("VALIDATION", `${remotePath}是目录，请先打包再传输`);
		if (maxBytes !== void 0 && st.size !== void 0 && st.size > maxBytes) throw new FileServiceError("FILE_TOO_LARGE", `${remotePath}超过传输上限 ${maxBytes} 字节`);
		return st.size;
	}
	/** fastPut 到临时文件，返回已传输字节（错误原样抛出，由 put 统一映射） */
	fastPutToTemp(localPath, temp, onProgress) {
		const throttled = throttleProgress(onProgress);
		let transferred = 0;
		return new Promise((resolve, reject) => {
			this.sftp.fastPut(localPath, temp, { step: (done, _chunk, fsize) => {
				transferred = done;
				throttled?.(done, fsize > 0 ? fsize : void 0);
			} }, (err) => err ? reject(err) : resolve(transferred));
		});
	}
	/** 流式上传到临时文件，返回已传输字节 */
	async pumpStreamToTemp(stream, temp, size, onProgress) {
		const throttled = throttleProgress(onProgress);
		let transferred = 0;
		stream.on("data", (chunk) => {
			transferred += chunk.length;
			throttled?.(transferred, size);
		});
		const ws = this.sftp.createWriteStream(temp);
		await pipeline(stream, ws);
		onProgress?.(transferred, size);
		return transferred;
	}
	/** 临时文件落到目标：先直接改名；SFTP v3 rename 不覆盖已存在目标，失败则删旧再改 */
	async place(temp, remotePath) {
		try {
			await this.rename(temp, remotePath);
		} catch {
			await this.unlinkQuietly(remotePath);
			await this.rename(temp, remotePath);
		}
	}
	rename(from, to) {
		return new Promise((resolve, reject) => {
			this.sftp.rename(from, to, (err) => err ? reject(err) : resolve());
		});
	}
	/** 删除文件；NOT_FOUND 静默忽略，其余错误也静默（清理路径不打断主流程） */
	async unlinkQuietly(path) {
		try {
			await new Promise((resolve, reject) => {
				this.sftp.unlink(path, (err) => err ? reject(err) : resolve());
			});
		} catch {}
	}
};
//#endregion
//#region src/transport/types.ts
var TransportError = class extends Error {
	code;
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
	}
};
//#endregion
//#region src/transport/ssh.ts
/**
* B2 SSH 传输 —— ssh2 驱动（定案：统一 shell() 交互通道，带 PTY）。
* MVP 阶段主机密钥不做严格校验（接受任意并继续），后续做"首次信任"（见方案 2.2 与已知风险）。
*
* 半死连接兜底：
* - keepalive 30s × 3（`TM_SSH_KEEPALIVE_MS` / `TM_SSH_KEEPALIVE_COUNT` 可覆盖），黑洞连接会触发 close。
* - 懒开 SFTP 子通道默认 30s 超时（`TM_SFTP_OPEN_TIMEOUT_MS` 可覆盖），超时不永久挂起，可重试。
* - 连接关闭时主动 reject 仍 pending 的 SFTP open，避免文件操作无限等待。
*
* @module dsh-terminal-manager/transport/ssh
*/
/** 把 ssh2 的错误映射成统一错误码（消息不含凭据）。 */
function mapSshError(err, options) {
	const e = err ?? {};
	const message = e.message ?? String(err);
	const target = `${options.host}:${options.port}`;
	if (e.level === "client-authentication" || /authentication/i.test(message)) return new TransportError("AUTH_FAILED", `SSH 认证失败（用户名或密码/密钥不对）: ${target}`, { cause: err });
	if (/timed out/i.test(message)) return new TransportError("CONN_TIMEOUT", `连接 ${target} 超时`, { cause: err });
	if (e.level === "client-socket" || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN/.test(e.code ?? "")) return new TransportError("HOST_UNREACHABLE", `无法连接 ${target}`, { cause: err });
	return new TransportError("PROTO_ERROR", `SSH 协议错误: ${message}`, { cause: err });
}
/** SFTP 子通道开关超时默认值：30 秒（半死连接下 ssh2 的 conn.sftp 可能永远不回调）。 */
const DEFAULT_SFTP_OPEN_TIMEOUT_MS = 3e4;
/** SSH keepalive 间隔默认 30 秒。 */
const DEFAULT_KEEPALIVE_INTERVAL_MS = 3e4;
/** 读正整数环境变量；非法（空/负数/小数/NaN）回退默认值。 */
function readPositiveInt(env, name, fallback) {
	const raw = env[name];
	if (raw === void 0) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) return fallback;
	return value;
}
/** 解析 SSH 运行时参数（测试可传 env；生产默认 process.env）。 */
function resolveSshSettings(env = process.env) {
	return {
		sftpOpenTimeoutMs: readPositiveInt(env, "TM_SFTP_OPEN_TIMEOUT_MS", DEFAULT_SFTP_OPEN_TIMEOUT_MS),
		keepaliveIntervalMs: readPositiveInt(env, "TM_SSH_KEEPALIVE_MS", DEFAULT_KEEPALIVE_INTERVAL_MS),
		keepaliveCountMax: readPositiveInt(env, "TM_SSH_KEEPALIVE_COUNT", 3)
	};
}
/** 建立一条 SSH 交互通道。失败抛 TransportError。 */
function connectSsh(options, callbacks, terminal = {
	cols: 120,
	rows: 32
}, deps = {}) {
	const timeoutMs = options.connectTimeoutMs ?? 15e3;
	const settings = resolveSshSettings(deps.env ?? process.env);
	return new Promise((resolve, reject) => {
		const conn = deps.createClient !== void 0 ? deps.createClient() : new Client();
		let settled = false;
		let connected = false;
		let closed = false;
		let sftpPromise;
		let sftpRaw;
		const pendingSftpRejects = /* @__PURE__ */ new Set();
		const fail = (err) => {
			if (settled) return;
			settled = true;
			conn.end();
			reject(mapSshError(err, options));
		};
		const cleanupPendingSftp = () => {
			const pending = [...pendingSftpRejects];
			pendingSftpRejects.clear();
			for (const rejectPending of pending) rejectPending(new TransportError("DISCONNECTED", "SSH 连接已断开，SFTP 打开被取消"));
			sftpPromise = void 0;
			sftpRaw = void 0;
		};
		const finishClose = (reason) => {
			if (closed || !connected) return;
			closed = true;
			callbacks.onClose(reason);
		};
		conn.on("error", (err) => {
			if (!settled) fail(err);
			else cleanupPendingSftp();
		});
		conn.on("close", () => {
			cleanupPendingSftp();
			finishClose("SSH 连接关闭");
		});
		conn.once("ready", () => {
			connected = true;
			conn.shell({
				term: "xterm-256color",
				cols: terminal.cols,
				rows: terminal.rows
			}, (err, channel) => {
				if (err) {
					fail(err);
					return;
				}
				if (settled) {
					channel.close();
					return;
				}
				settled = true;
				channel.on("data", (chunk) => callbacks.onData(chunk.toString("utf8")));
				channel.stderr.on("data", (chunk) => callbacks.onData(chunk.toString("utf8")));
				channel.on("close", () => {
					cleanupPendingSftp();
					finishClose("SSH 通道关闭");
					conn.end();
				});
				resolve({
					write: (data) => {
						if (!closed) channel.write(data);
					},
					resize: (cols, rows) => {
						if (!closed) channel.setWindow(rows, cols, 0, 0);
					},
					getSftp: () => {
						if (closed) return Promise.reject(new TransportError("DISCONNECTED", "SSH 连接已断开，无法打开 SFTP"));
						if (sftpPromise !== void 0) return sftpPromise;
						const guarded = new Promise((resolveSftp, rejectSftp) => {
							let done = false;
							let timer;
							const rejectOnce = (error) => {
								if (done) return;
								done = true;
								if (timer !== void 0) clearTimeout(timer);
								pendingSftpRejects.delete(rejectOnce);
								rejectSftp(error);
							};
							timer = setTimeout(() => {
								rejectOnce(new TransportError("PROTO_ERROR", `打开 SFTP 子通道超时（${settings.sftpOpenTimeoutMs}ms）`));
							}, settings.sftpOpenTimeoutMs);
							pendingSftpRejects.add(rejectOnce);
							conn.sftp((sftpErr, sftp) => {
								if (done) {
									try {
										sftp?.end();
									} catch {}
									return;
								}
								done = true;
								if (timer !== void 0) clearTimeout(timer);
								pendingSftpRejects.delete(rejectOnce);
								if (sftpErr) {
									rejectSftp(closed ? new TransportError("DISCONNECTED", "SSH 连接已断开，无法打开 SFTP") : new TransportError("PROTO_ERROR", `打开 SFTP 子通道失败: ${sftpErr.message}`, { cause: sftpErr }));
									return;
								}
								sftpRaw = sftp;
								sftp.on("close", () => {
									sftpPromise = void 0;
									sftpRaw = void 0;
								});
								resolveSftp(new SftpFacade(sftp));
							});
						}).catch((error) => {
							sftpPromise = void 0;
							throw error;
						});
						sftpPromise = guarded;
						return guarded;
					},
					close: async () => {
						finishClose("本端主动断开");
						const rawSftp = sftpRaw;
						cleanupPendingSftp();
						rawSftp?.end();
						channel.close();
						conn.end();
					}
				});
			});
		});
		conn.connect({
			host: options.host,
			port: options.port,
			username: options.username,
			readyTimeout: timeoutMs,
			keepaliveInterval: settings.keepaliveIntervalMs,
			keepaliveCountMax: settings.keepaliveCountMax,
			hostVerifier: () => true,
			...options.auth?.kind === "password" ? { password: options.auth.password } : {},
			...options.auth?.kind === "key" ? {
				privateKey: options.auth.privateKey,
				...options.auth.passphrase !== void 0 ? { passphrase: options.auth.passphrase } : {}
			} : {}
		});
	});
}
//#endregion
//#region src/transport/probe.ts
/**
* 连接探针 —— 不建立会话/不开 shell，只验证设备是否可达、SSH 能否认证。
*
* Telnet：TCP connect 成功即视为可达（无认证概念）。
* SSH：握手 + 认证到 ready 后立即 end（不建 Transport、不开 PTY）。
* 错误只映射成统一码 + 人类可读原因，message 永不含凭据。
* @module dsh-terminal-manager/transport/probe
*/
/** 探针默认超时（毫秒）。 */
const DEFAULT_PROBE_TIMEOUT_MS = 5e3;
/** 把底层异常映射成统一探针错误码。 */
function probeCodeOf(error) {
	const err = error;
	if (err.level === "client-authentication") return "AUTH_FAILED";
	switch (err.code) {
		case "ECONNREFUSED":
		case "ENOTFOUND":
		case "EAI_AGAIN":
		case "EHOSTUNREACH":
		case "ENETUNREACH": return "HOST_UNREACHABLE";
		case "ETIMEDOUT": return "CONN_TIMEOUT";
		default: return "PROTO_ERROR";
	}
}
function reasonOf(code) {
	switch (code) {
		case "AUTH_FAILED": return "认证失败";
		case "HOST_UNREACHABLE": return "无法连接";
		case "CONN_TIMEOUT": return "连接超时";
		default: return "协议错误";
	}
}
/** 探测一条已保存的连接。 */
function probeConnection(cfg, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
	const started = Date.now();
	const base = {
		connId: cfg.id,
		label: cfg.label,
		protocol: cfg.protocol
	};
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				...base,
				...result
			});
		};
		const timer = setTimeout(() => {
			finish({
				ok: false,
				code: "CONN_TIMEOUT",
				reason: reasonOf("CONN_TIMEOUT")
			});
		}, timeoutMs);
		if (cfg.protocol === "telnet") {
			const socket = net.connect({
				host: cfg.host,
				port: cfg.port
			});
			socket.once("connect", () => {
				finish({
					ok: true,
					latencyMs: Date.now() - started
				});
				socket.destroy();
			});
			socket.once("error", (error) => {
				const code = probeCodeOf(error);
				finish({
					ok: false,
					code,
					reason: reasonOf(code)
				});
				socket.destroy();
			});
			return;
		}
		const client = new Client();
		client.once("ready", () => {
			finish({
				ok: true,
				latencyMs: Date.now() - started
			});
			client.end();
		});
		client.once("error", (error) => {
			const code = probeCodeOf(error);
			finish({
				ok: false,
				code,
				reason: reasonOf(code)
			});
			try {
				client.end();
			} catch {}
		});
		try {
			client.connect({
				host: cfg.host,
				port: cfg.port,
				username: cfg.username ?? "",
				...cfg.auth?.kind === "password" ? { password: cfg.auth.password } : {},
				...cfg.auth?.kind === "key" ? {
					privateKey: cfg.auth.privateKey,
					...cfg.auth.passphrase !== void 0 ? { passphrase: cfg.auth.passphrase } : {}
				} : {},
				readyTimeout: timeoutMs,
				hostVerifier: () => true
			});
		} catch (error) {
			const code = probeCodeOf(error);
			finish({
				ok: false,
				code,
				reason: reasonOf(code)
			});
		}
	});
}
/** 批量探测；并发上限 5（对齐主设计文档）。 */
async function probeMany(cfgs, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
	const results = [];
	for (let i = 0; i < cfgs.length; i += 5) results.push(...await Promise.all(cfgs.slice(i, i + 5).map((cfg) => probeConnection(cfg, timeoutMs))));
	return results;
}
/** 默认终端类型（比传统 xterm 多 256 色，xterm.js 前端匹配）。 */
const DEFAULT_TERMINAL_TYPE = "xterm-256color";
const LOCAL_OPTIONS = /* @__PURE__ */ new Set([
	1,
	3,
	24,
	31
]);
const REMOTE_OPTIONS = /* @__PURE__ */ new Set([1, 3]);
/**
* 三档归一化：`passive`（默认）/ `active` / `raw`。
* 兼容旧值 `'telnet'`（等价 active）与缺省（passive）。
*/
function normalizeTelnetMode(mode) {
	if (mode === "raw") return "raw";
	if (mode === "active" || mode === "telnet") return "active";
	return "passive";
}
/** 构建 3 字节命令（IAC + cmd + option）。 */
function iacCommand(cmd, option) {
	return Buffer.from([
		255,
		cmd,
		option
	]);
}
/**
* 子协商数据里的 0xFF 转义为 IAC IAC（RFC 1073 / RFC 855）。
* 同时用于用户输入：只有确认/激活的 telnetd 才需要把裸 0xFF 双写。
*/
function escapeIac(data) {
	if (!data.includes(255)) return data;
	const out = [];
	for (const byte of data) {
		out.push(byte);
		if (byte === 255) out.push(255);
	}
	return Buffer.from(out);
}
/** 用户输入 0xFF 转义（与子协商规则相同：IAC IAC）。 */
function escapeUserInput(data) {
	return escapeIac(data);
}
/** 构建 IAC SB option <data> IAC SE（data 里的 0xFF 自动转义）。 */
function iacSubnegotiation(option, data) {
	return Buffer.concat([
		Buffer.from([
			255,
			250,
			option
		]),
		escapeIac(data),
		Buffer.from([255, 240])
	]);
}
/** NAWS 子协商：宽度/高度各 2 字节大端（RFC 1073）。 */
function buildNaws(cols, rows) {
	const data = Buffer.alloc(4);
	data.writeUInt16BE(cols & 65535, 0);
	data.writeUInt16BE(rows & 65535, 2);
	return iacSubnegotiation(31, data);
}
/** TTYPE 子协商：IS + 终端类型。 */
function buildTerminalType(terminalType = DEFAULT_TERMINAL_TYPE) {
	return iacSubnegotiation(24, Buffer.concat([Buffer.from([0]), Buffer.from(terminalType, "ascii")]));
}
/** active 模式的初始协商：1 条 DO SGA（探测用）；NAWS 等探测有结果后再发。 */
function initialNegotiation(mode) {
	if (mode !== "active") return [];
	return [iacCommand(253, 3)];
}
const NEGOTIATION_COMMANDS = /* @__PURE__ */ new Set([
	251,
	252,
	253,
	254
]);
/**
* 跨 chunk 的 IAC 解析状态机。
* 数据按出现顺序回调：`data ` 字节先于/后于协商命令的先后关系不会被合并打乱。
*/
var TelnetStreamParser = class {
	handlers;
	state = "data";
	command = 0;
	subOption = 0;
	subData = [];
	constructor(handlers) {
		this.handlers = handlers;
	}
	feed(chunk) {
		let dataStart = -1;
		const flushData = (end) => {
			if (dataStart >= 0 && end > dataStart) this.handlers.onData(chunk.subarray(dataStart, end));
			dataStart = -1;
		};
		for (let i = 0; i < chunk.length; i++) {
			const byte = chunk[i];
			switch (this.state) {
				case "data":
					if (byte === 255) {
						flushData(i);
						this.state = "iac";
					} else if (dataStart < 0) dataStart = i;
					break;
				case "iac":
					if (byte === 255) {
						this.handlers.onData(Buffer.from([255]));
						this.state = "data";
					} else if (byte === 250) this.state = "sb";
					else if (NEGOTIATION_COMMANDS.has(byte)) {
						this.command = byte;
						this.state = "cmd";
					} else this.state = "data";
					break;
				case "cmd":
					this.handlers.onCommand(this.command, byte);
					this.state = "data";
					break;
				case "sb":
					this.subOption = byte;
					this.subData = [];
					this.state = "sb-data";
					break;
				case "sb-data":
					if (byte === 255) this.state = "sb-iac";
					else this.subData.push(byte);
					break;
				case "sb-iac": if (byte === 240) {
					this.handlers.onSubnegotiation(this.subOption, Buffer.from(this.subData));
					this.subData = [];
					this.state = "data";
				} else if (byte === 255) {
					this.subData.push(255);
					this.state = "sb-data";
				} else {
					this.subData = [];
					this.state = "data";
				}
			}
		}
		flushData(chunk.length);
	}
	/** 当前是否有跨 chunk 的半截序列（测试/诊断用）。 */
	get pending() {
		return this.state !== "data" || this.subData.length > 0;
	}
};
/**
* per-option 简化 RFC 1143 Q-method。
*
* 每个选项本端/对端各两态（NO/YES）：
* - 收到 DO：本端已是 YES → 不回；否则 YES + WILL（不支持的选项回 WONT）。
* - 收到 DONT：本端已是 NO → 不回；否则 NO + WONT。
* - 收到 WILL：对端已是 YES → 不回；可接受则 YES + DO，否则回 DONT。
* - 收到 WONT：对端已是 NO → 不回；否则 NO + DONT。
*
* 这样对端重复发同一请求时不会来回 WILL/WONT 打环（RFC 1143 的核心目的）。
*/
var TelnetNegotiator = class {
	local = /* @__PURE__ */ new Map();
	remote = /* @__PURE__ */ new Map();
	terminalType;
	negotiationSeen = false;
	constructor(options = {}) {
		this.terminalType = options.terminalType ?? "xterm-256color";
	}
	/** 是否已经见过任意合法 IAC 协商（真 telnetd 的判据）。 */
	get confirmed() {
		return this.negotiationSeen;
	}
	/** 主动模式探测超时后的保守判定：按 telnetd 继续。 */
	markConfirmed() {
		this.negotiationSeen = true;
	}
	/** 本端某选项是否已启用（如 NAWS：对端 DO 过才允许发窗口大小）。 */
	localEnabled(option) {
		return this.local.get(option) === true;
	}
	/** 处理 WILL/WONT/DO/DONT，返回要回写的字节序列。 */
	handleCommand(cmd, option) {
		this.negotiationSeen = true;
		const responses = [];
		if (cmd === 253) {
			if (this.local.get(option) === true) return responses;
			if (LOCAL_OPTIONS.has(option)) {
				this.local.set(option, true);
				responses.push(iacCommand(251, option));
			} else responses.push(iacCommand(252, option));
		} else if (cmd === 254) {
			if (this.local.get(option) === true) {
				this.local.set(option, false);
				responses.push(iacCommand(252, option));
			}
		} else if (cmd === 251) {
			if (this.remote.get(option) === true) return responses;
			if (REMOTE_OPTIONS.has(option)) {
				this.remote.set(option, true);
				responses.push(iacCommand(253, option));
			} else responses.push(iacCommand(254, option));
		} else if (cmd === 252) {
			if (this.remote.get(option) === true) {
				this.remote.set(option, false);
				responses.push(iacCommand(254, option));
			}
		}
		return responses;
	}
	/** 处理子协商；目前只需应答 TTYPE SEND。 */
	handleSubnegotiation(option, data) {
		this.negotiationSeen = true;
		if (option === 24 && data.length > 0 && data[0] === 1) return [buildTerminalType(this.terminalType)];
		return [];
	}
};
//#endregion
//#region src/transport/telnet.ts
/**
* B3 Telnet 传输 —— 三档模式：passive（默认）/ active / raw。
*
* - passive（默认）：连接后不主动发协商，只回应服务器发来的 WILL/WONT/DO/DONT；
*   TTYPE / NAWS 在服务器请求时回；输入不做 0xFF 转义（除非已确认是真 telnetd）。
* - active：连接后发 1 条 DO SGA 并开 800ms 探测窗口——收到合法 IAC 判真 telnetd；
*   收到非 IAC 数据立即切被动（裸 shell，不再主动协商）；超时保守按 telnetd 继续。
* - raw：纯 TCP 透传，不解析 IAC、不协商、不转义（串口服务器 / ESL）。
* - 旧值 `'telnet'` 归一化为 `'active'`；缺省归一化为 `'passive'`。
*
* @module dsh-terminal-manager/transport/telnet
*/
const RESIZE_DEBOUNCE_MS = 150;
/** 建立一条 Telnet/裸 TCP 连接。失败抛 TransportError。 */
function connectTelnet(options, callbacks) {
	const timeoutMs = options.connectTimeoutMs ?? 15e3;
	const mode = normalizeTelnetMode(options.telnetMode);
	return new Promise((resolve, reject) => {
		let settled = false;
		const socket = net.connect({
			host: options.host,
			port: options.port
		});
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(new TransportError("CONN_TIMEOUT", `连接 ${options.host}:${options.port} 超时（${timeoutMs}ms）`));
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			if (settled) return;
			settled = true;
			let closed = false;
			let probePending = mode === "active";
			let probeTimer;
			let confirmed = false;
			let bareShell = false;
			let lastCols = -1;
			let lastRows = -1;
			let resizeTimer;
			let pendingSize = null;
			const clearProbeTimer = () => {
				if (probeTimer !== void 0) {
					clearTimeout(probeTimer);
					probeTimer = void 0;
				}
			};
			const finishClose = (reason) => {
				if (closed) return;
				closed = true;
				clearProbeTimer();
				if (resizeTimer !== void 0) {
					clearTimeout(resizeTimer);
					resizeTimer = void 0;
				}
				callbacks.onClose(reason);
			};
			const negotiator = mode === "raw" ? void 0 : new TelnetNegotiator();
			const sendWindowSize = (cols, rows) => {
				if (closed || mode === "raw") return;
				lastCols = cols;
				lastRows = rows;
				socket.write(buildNaws(cols, rows));
			};
			/** 当前能否发 NAWS：passive 必须等服务器 DO NAWS；active 探测确认后即可。 */
			const canSendNaws = () => {
				if (mode === "raw" || bareShell) return false;
				if (negotiator?.localEnabled(31) === true) return true;
				return mode === "active" && confirmed;
			};
			/**
			* active 的初始窗口大小：探测出结果后再发（避免把 NAWS 字节糊到裸 shell 里）。
			* 服务器先 DO NAWS 时由命令分支立即回，不会重复。
			*/
			const sendInitialWindowSize = () => {
				if (mode === "active" && !bareShell && lastCols < 0) sendWindowSize(80, 24);
			};
			/** 收到任意合法 IAC：确认是真 telnetd，结束探测。 */
			const confirmTelnetd = () => {
				probePending = false;
				clearProbeTimer();
				confirmed = true;
				negotiator?.markConfirmed();
			};
			const parser = negotiator === void 0 ? void 0 : new TelnetStreamParser({
				onData: (data) => {
					if (data.length === 0) return;
					if (probePending) {
						probePending = false;
						clearProbeTimer();
						bareShell = true;
					}
					callbacks.onData(data.toString("utf8"));
				},
				onCommand: (cmd, option) => {
					if (closed || negotiator === void 0 || bareShell) return;
					confirmTelnetd();
					for (const response of negotiator.handleCommand(cmd, option)) socket.write(response);
					if (cmd === 253 && option === 31 && negotiator.localEnabled(31)) sendWindowSize(lastCols < 0 ? 80 : lastCols, lastRows < 0 ? 24 : lastRows);
					sendInitialWindowSize();
				},
				onSubnegotiation: (option, data) => {
					if (closed || negotiator === void 0 || bareShell) return;
					confirmTelnetd();
					for (const response of negotiator.handleSubnegotiation(option, data)) socket.write(response);
					sendInitialWindowSize();
				}
			});
			const requestResize = (cols, rows) => {
				if (mode === "raw" || closed) return;
				if (cols === lastCols && rows === lastRows) return;
				pendingSize = {
					cols,
					rows
				};
				if (resizeTimer === void 0) resizeTimer = setTimeout(() => {
					resizeTimer = void 0;
					const size = pendingSize;
					pendingSize = null;
					if (size === null || closed || !canSendNaws()) return;
					sendWindowSize(size.cols, size.rows);
				}, RESIZE_DEBOUNCE_MS);
			};
			for (const frame of initialNegotiation(mode)) socket.write(frame);
			if (mode === "active") probeTimer = setTimeout(() => {
				probeTimer = void 0;
				if (closed || !probePending) return;
				confirmTelnetd();
				sendInitialWindowSize();
			}, 800);
			socket.on("data", (chunk) => {
				if (closed) return;
				if (parser === void 0) callbacks.onData(chunk.toString("utf8"));
				else parser.feed(chunk);
			});
			socket.on("error", (error) => {
				finishClose(`连接错误: ${error.code ?? error.message}`);
				socket.destroy();
			});
			socket.on("close", () => finishClose("对端关闭或连接断开"));
			resolve({
				write: (data) => {
					if (closed) return;
					const bytes = Buffer.from(data, "utf8");
					socket.write(confirmed && mode !== "raw" ? escapeUserInput(bytes) : bytes);
				},
				resize: (cols, rows) => {
					requestResize(cols, rows);
				},
				close: async () => {
					finishClose("本端主动断开");
					socket.destroy();
				}
			});
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			if (settled) return;
			settled = true;
			const code = error.code;
			reject(new TransportError("HOST_UNREACHABLE", `无法连接 ${options.host}:${options.port}（${code ?? error.message}）`, { cause: error }));
		});
	});
}
//#endregion
//#region src/session-manager.ts
/**
* B4 会话管理器 —— 整个插件的心脏。
*
* 持有全部活跃会话：状态机、环形缓冲、输出分发、广播、独占发送。
* 三个门（指令通道 / 数据流通道 / AI 工具）都只通过它；它是唯一接触传输层的地方。
* 「看」（订阅）与「连」（会话）分离：订阅随管道生灭，会话只在显式断开/掉线/卸载时终结。
* @module dsh-terminal-manager/session-manager
*/
var SessionError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
const defaultTransportFactory = (target, callbacks) => {
	return target.protocol === "ssh" ? connectSsh(target, callbacks) : connectTelnet(target, callbacks);
};
/** 每会话输出环形缓冲上限（1MB）。 */
const BUFFER_CAP_BYTES = 1048576;
/** 完成判定轮询间隔。 */
const POLL_INTERVAL_MS = 50;
/** 键盘模式默认值：退格/删除都发 DEL（127）；可在连接配置或运行时切到 ^H（8）。 */
const DEFAULT_BACKSPACE_BYTE = 127;
const DEFAULT_DELETE_BYTE = 127;
/** 输入来源缺省规则：传了 guard 就是 AI 路径，否则是人。 */
function sourceOf(options, fallback = "human") {
	return options.source ?? (options.guard !== void 0 ? "ai" : fallback);
}
/** 会话池。 */
var SessionManager = class {
	store;
	transportFactory;
	events;
	sessions = /* @__PURE__ */ new Map();
	statusListeners = /* @__PURE__ */ new Set();
	constructor(store, transportFactory = defaultTransportFactory, events = createEventBus()) {
		this.store = store;
		this.transportFactory = transportFactory;
		this.events = events;
	}
	/** 订阅会话状态变化（连接中/已连接/已关闭）。返回取消函数。 */
	onStatus(listener) {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}
	list() {
		return [...this.sessions.values()].map((r) => this.snapshot(r));
	}
	get(sessionId) {
		const record = this.sessions.get(sessionId);
		return record === void 0 ? void 0 : this.snapshot(record);
	}
	/** 按 host+port 查找已保存的连接配置（用于 AI 工具匹配已有配置）。 */
	findConnectionByTarget(protocol, host, port) {
		if (this.store === void 0) return void 0;
		const targetPort = port ?? (protocol === "ssh" ? 22 : 23);
		for (const conn of this.store.list()) if (conn.protocol === protocol && conn.host === host && conn.port === targetPort) return {
			connId: conn.id,
			label: conn.label
		};
	}
	/** 用已保存的连接建立会话；同一连接重复调用返回既有会话。 */
	async connectByConnId(connId) {
		if (this.store === void 0) throw new SessionError("SESSION_NOT_FOUND", "未配置连接存储");
		await this.store.ensureLoaded();
		const conn = this.store.get(connId);
		if (conn === void 0) throw new SessionError("SESSION_NOT_FOUND", `连接不存在: ${connId}`);
		for (const record of this.sessions.values()) if (record.connId === connId && record.status !== "closed") return this.snapshot(record);
		return this.connect({
			protocol: conn.protocol,
			host: conn.host,
			port: conn.port,
			username: conn.username,
			label: conn.label,
			...conn.auth !== void 0 ? { auth: conn.auth } : {},
			...conn.telnetMode !== void 0 ? { telnetMode: conn.telnetMode } : {},
			...conn.connectTimeoutMs !== void 0 ? { connectTimeoutMs: conn.connectTimeoutMs } : {},
			...conn.newline !== void 0 ? { newline: conn.newline } : {},
			...conn.localEcho !== void 0 ? { localEcho: conn.localEcho } : {}
		}, connId);
	}
	/** 建立会话。同 protocol+host:port 的 open 会话直接复用（去重）。
	*  无 connId 时自动创建连接配置入库（出现在「最近连接」）。 */
	async connect(target, connId) {
		const targetKey = `${target.protocol}:${target.host}:${target.port}`;
		for (const record of this.sessions.values()) if (record.status === "open" && `${record.protocol}:${record.target}` === targetKey) return this.snapshot(record);
		let effectiveConnId = connId;
		if (effectiveConnId === void 0 && this.store !== void 0) {
			await this.store.ensureLoaded();
			effectiveConnId = (await this.store.create({
				protocol: target.protocol,
				host: target.host,
				port: target.port,
				label: target.label ?? target.host,
				favorited: false,
				...target.username !== void 0 ? { username: target.username } : {},
				...target.auth !== void 0 ? { auth: target.auth } : {},
				...target.telnetMode !== void 0 ? { telnetMode: target.telnetMode } : {}
			})).id;
		}
		const persisted = effectiveConnId !== void 0 && this.store !== void 0 ? this.store.get(effectiveConnId) : void 0;
		const sessionId = randomUUID();
		const record = {
			sessionId,
			connId: effectiveConnId,
			label: target.label ?? target.host,
			target: `${target.host}:${target.port}`,
			protocol: target.protocol,
			status: "connecting",
			buffer: "",
			subscribers: /* @__PURE__ */ new Set(),
			busy: false,
			...target.newline !== void 0 ? { newline: target.newline } : {},
			backspaceByte: persisted?.backspaceByte ?? DEFAULT_BACKSPACE_BYTE,
			deleteByte: persisted?.deleteByte ?? DEFAULT_DELETE_BYTE
		};
		this.sessions.set(sessionId, record);
		this.notify(record);
		try {
			record.transport = await this.transportFactory(target, {
				onData: (chunk) => this.handleData(record, chunk),
				onClose: (reason) => this.handleClose(record, reason)
			});
			record.status = "open";
			record.openedAtMs = Date.now();
			this.notify(record);
			return this.snapshot(record);
		} catch (error) {
			this.sessions.delete(sessionId);
			throw error;
		}
	}
	/** 主动断开会话（用户操作）。标记为 removed 并从列表中删除。 */
	async disconnect(sessionId) {
		const record = this.requireRecord(sessionId);
		if (record.status === "removed") return;
		record.status = "removed";
		this.sessions.delete(record.sessionId);
		if (record.transport !== void 0) {
			try {
				await record.transport.close();
			} catch {}
			record.transport = void 0;
		}
		this.notify(record);
	}
	/** 重连已断开的会话（被动断开后恢复）。 */
	async reconnect(sessionId) {
		const record = this.requireRecord(sessionId);
		if (record.status !== "closed") throw new SessionError("SESSION_NOT_DISCONNECTED", "会话未处于断开状态");
		if (record.transport !== void 0) {
			try {
				await record.transport.close();
			} catch {}
			record.transport = void 0;
		}
		record.status = "connecting";
		record.closeReason = void 0;
		this.notify(record);
		try {
			const conn = record.connId !== void 0 && this.store !== void 0 ? this.store.get(record.connId) : void 0;
			if (conn === void 0) throw new SessionError("SESSION_NOT_FOUND", "无法获取连接配置");
			record.backspaceByte = conn.backspaceByte ?? DEFAULT_BACKSPACE_BYTE;
			record.deleteByte = conn.deleteByte ?? DEFAULT_DELETE_BYTE;
			record.transport = await this.transportFactory({
				protocol: conn.protocol,
				host: conn.host,
				port: conn.port,
				username: conn.username,
				...conn.auth !== void 0 ? { auth: conn.auth } : {},
				...conn.telnetMode !== void 0 ? { telnetMode: conn.telnetMode } : {},
				...conn.connectTimeoutMs !== void 0 ? { connectTimeoutMs: conn.connectTimeoutMs } : {}
			}, {
				onData: (chunk) => this.handleData(record, chunk),
				onClose: (reason) => this.handleClose(record, reason)
			});
			record.status = "open";
			record.openedAtMs = Date.now();
			this.notify(record);
			return this.snapshot(record);
		} catch (error) {
			record.status = "closed";
			this.notify(record);
			throw error;
		}
	}
	/** 订阅一个会话的输出（"看"）。返回取消订阅函数。 */
	subscribe(sessionId, listener) {
		const record = this.requireRecord(sessionId);
		record.subscribers.add(listener);
		return () => {
			record.subscribers.delete(listener);
		};
	}
	/** 人工键入：原样写入，不排队、不过守卫。 */
	write(sessionId, data) {
		this.requireOpen(sessionId).transport?.write(data);
		this.events.emit({
			type: "input",
			sessionId,
			data,
			source: "human",
			ts: Date.now()
		});
	}
	/** AI 路径"发完即回"：过守卫，追加换行写入，不等待执行完成。换行优先用调用参数，其次连接级配置，缺省 crlf。 */
	async sendImmediate(sessionId, command, options = {}) {
		const record = this.requireOpen(sessionId);
		if (record.busy) throw new SessionError("SESSION_BUSY", "该会话正在执行另一条发送");
		this.assertAllowed(record, command, options);
		record.transport?.write(command + this.eolOf(record, options.newline));
		this.events.emit({
			type: "input",
			sessionId,
			data: command,
			source: sourceOf(options),
			ts: Date.now()
		});
	}
	resize(sessionId, cols, rows) {
		this.requireOpen(sessionId).transport?.resize?.(cols, rows);
	}
	/** 读取某会话的键盘模式（退格/删除键字节）。 */
	getKeyboardMode(sessionId) {
		const record = this.requireRecord(sessionId);
		return {
			backspaceByte: record.backspaceByte,
			deleteByte: record.deleteByte
		};
	}
	/** 运行时切换键盘模式（只影响当前会话；连接配置里的值在下一次连接/重连时装载）。 */
	setKeyboardMode(sessionId, mode) {
		const record = this.requireRecord(sessionId);
		if (mode.backspaceByte !== void 0) {
			if (mode.backspaceByte !== 8 && mode.backspaceByte !== 127) throw new Error("退格字节只能是 8 或 127");
			record.backspaceByte = mode.backspaceByte;
		}
		if (mode.deleteByte !== void 0) {
			if (mode.deleteByte !== 8 && mode.deleteByte !== 127) throw new Error("删除字节只能是 8 或 127");
			record.deleteByte = mode.deleteByte;
		}
		return {
			backspaceByte: record.backspaceByte,
			deleteByte: record.deleteByte
		};
	}
	/**
	* 取会话的 SFTP 门面（S5）。SFTP 走 SSH 独立子通道，不占 PTY 字节流，
	* 与 sendAndWait / 人工键入互不干扰，因此无 SESSION_BUSY 独占锁。
	* 协议分派在 FileService（Telnet → UNSUPPORTED）；本方法只面向「会话 → 门面」。
	*/
	async getSftp(sessionId) {
		const transport = this.requireOpen(sessionId).transport;
		const getSftp = transport?.getSftp;
		if (transport === void 0 || getSftp === void 0) throw new SessionError("DISCONNECTED", "该会话不支持 SFTP（仅 SSH 会话提供文件传输）");
		return getSftp.call(transport);
	}
	/** 读当前缓冲（回看）。 */
	read(sessionId, count = 500) {
		const lines = this.requireRecord(sessionId).buffer.split("\n");
		const totalLines = lines.length;
		return {
			text: lines.slice(-count).join("\n"),
			totalLines,
			truncated: totalLines > count
		};
	}
	/**
	* 发送命令并等待执行完成（AI 路径）。独占：同会话同时只跑一条。
	* guard 传入时做命令守卫检查（命中抛 COMMAND_BLOCKED）。
	*/
	async sendAndWait(sessionId, command, options = {}) {
		const record = this.requireOpen(sessionId);
		if (record.busy) throw new SessionError("SESSION_BUSY", "该会话正在执行另一条发送");
		this.assertAllowed(record, command, options);
		if (options.signal?.aborted) throw new SessionError("DISCONNECTED", "发送已被取消");
		record.busy = true;
		try {
			const policy = new WaitPolicy(this.resolveWaitConfig(record, options.wait));
			const submit = options.submit ?? true;
			const eol = this.eolOf(record, options.newline);
			const outcome = await new Promise((resolve, reject) => {
				policy.start(Date.now());
				let done = false;
				const finish = (reason) => {
					if (done) return;
					done = true;
					clearInterval(timer);
					unsubscribe();
					resolve(reason);
				};
				const fail = (error) => {
					if (done) return;
					done = true;
					clearInterval(timer);
					unsubscribe();
					reject(error);
				};
				const unsubscribe = this.subscribe(sessionId, (chunk) => {
					const reason = policy.feed(chunk, Date.now());
					if (reason !== void 0) finish(reason);
				});
				const timer = setInterval(() => {
					if (options.signal?.aborted) {
						fail(new SessionError("DISCONNECTED", "发送已被取消"));
						return;
					}
					if (record.status !== "open") {
						fail(new SessionError("DISCONNECTED", "等待期间会话已断开"));
						return;
					}
					const reason = policy.poll(Date.now());
					if (reason !== void 0) finish(reason);
				}, POLL_INTERVAL_MS);
				record.transport?.write(command + (submit ? eol : ""));
				this.events.emit({
					type: "input",
					sessionId,
					data: command,
					source: sourceOf(options),
					ts: Date.now()
				});
			});
			return {
				output: policy.output(),
				waitReason: outcome,
				truncated: policy.truncated()
			};
		} finally {
			record.busy = false;
		}
	}
	/**
	* 同会话串行执行多条命令（tm_send 的 commands 分支）。
	* - 整批先做守卫预检：任一命中即整批不执行（第 N 条被拦截）；
	* - 每条独立完成判定，超时归 timeout 并继续下一条；
	* - 会话中途断开时把剩余条目标 skipped；取消（signal）标 aborted。
	*/
	async sendBatch(sessionId, commands, options = {}) {
		const record = this.requireOpen(sessionId);
		if (commands.length === 0) return [];
		if (options.guard !== void 0) {
			const merged = this.mergeGuard(record, options.guard);
			for (let i = 0; i < commands.length; i += 1) {
				const decision = checkCommand(commands[i], merged);
				if (decision.verdict === "block") throw new SessionError("COMMAND_BLOCKED", `第 ${i + 1} 条命令被安全策略拦截：${decision.rule?.why ?? "未知原因"}`);
			}
		}
		const results = [];
		let stopRemaining;
		for (let i = 0; i < commands.length; i += 1) {
			const command = commands[i];
			if (stopRemaining !== void 0) {
				results.push({
					index: i,
					command,
					outcome: "skipped"
				});
				continue;
			}
			if (options.signal?.aborted) {
				results.push({
					index: i,
					command,
					outcome: "aborted"
				});
				stopRemaining = "aborted";
				continue;
			}
			if (record.status !== "open") {
				results.push({
					index: i,
					command,
					outcome: "skipped"
				});
				stopRemaining = "skipped";
				continue;
			}
			try {
				const result = await this.sendAndWait(sessionId, command, options);
				results.push({
					index: i,
					command,
					outcome: result.waitReason === "timeout" ? "timeout" : "ok",
					output: result.output,
					waitReason: result.waitReason,
					truncated: result.truncated
				});
			} catch (error) {
				if (error instanceof SessionError && error.code === "COMMAND_BLOCKED") {
					results.push({
						index: i,
						command,
						outcome: "aborted"
					});
					stopRemaining = "aborted";
				} else if (error instanceof SessionError && error.code === "SESSION_BUSY") {
					results.push({
						index: i,
						command,
						outcome: "skipped"
					});
					stopRemaining = "skipped";
				} else {
					results.push({
						index: i,
						command,
						outcome: "disconnected"
					});
					stopRemaining = "skipped";
				}
			}
		}
		return results;
	}
	/** 广播：逐台独立执行、互不阻塞，每台单独出结果。 */
	async broadcast(command, targetSessionIds, rawOptions = {}) {
		const options = {
			...rawOptions,
			source: sourceOf(rawOptions, "broadcast")
		};
		const targets = targetSessionIds !== void 0 ? targetSessionIds : [...this.sessions.values()].filter((r) => r.status === "open").map((r) => r.sessionId);
		return await Promise.all(targets.map(async (sessionId) => {
			const record = this.sessions.get(sessionId);
			if (record === void 0 || record.status !== "open") return {
				sessionId,
				outcome: "disconnected",
				code: "DISCONNECTED"
			};
			if (record.busy) return {
				sessionId,
				outcome: "busy",
				code: "SESSION_BUSY"
			};
			try {
				return {
					sessionId,
					outcome: "ok",
					result: await this.sendAndWait(sessionId, command, options)
				};
			} catch (error) {
				return {
					sessionId,
					outcome: "error",
					code: error instanceof SessionError ? error.code : "PROTO_ERROR"
				};
			}
		}));
	}
	/** 批量探测已保存连接的可达性（并发 5，不开 shell）。 */
	async probeAll(connIds) {
		if (this.store === void 0) return [];
		await this.store.ensureLoaded();
		return probeMany((connIds ?? this.store.list().map((conn) => conn.id)).map((id) => this.store.get(id)).filter((cfg) => cfg !== void 0));
	}
	/** 关闭全部会话（插件卸载时用）。 */
	async closeAll() {
		await Promise.all([...this.sessions.values()].map((r) => r.transport?.close()));
	}
	/** 会话对应的连接配置（完成判定覆盖参数的来源）。 */
	connectionOf(record) {
		return record.connId !== void 0 ? this.store?.get(record.connId) : void 0;
	}
	/** 合并守卫选项：连接级白名单 + 调用方补充规则。 */
	mergeGuard(record, guard) {
		const whitelist = [...this.connectionOf(record)?.guardWhitelist ?? [], ...guard.whitelist ?? []];
		return {
			...whitelist.length > 0 ? { whitelist } : {},
			...guard.extraRules !== void 0 ? { extraRules: guard.extraRules } : {}
		};
	}
	/** 命令守卫检查（仅当 options.guard 传入时启用，即 AI 路径）。命中抛 COMMAND_BLOCKED。 */
	assertAllowed(record, command, options) {
		if (options.guard === void 0) return;
		const decision = checkCommand(command, this.mergeGuard(record, options.guard));
		if (decision.verdict === "block") throw new SessionError("COMMAND_BLOCKED", `命令被安全策略拦截：${decision.rule?.why ?? "未知原因"}`);
	}
	resolveWaitConfig(record, overrides) {
		const conn = this.connectionOf(record);
		return {
			...conn?.quietMs !== void 0 ? { quietMs: conn.quietMs } : {},
			...conn?.promptPattern !== void 0 ? { promptPattern: conn.promptPattern } : {},
			...conn?.timeoutMs !== void 0 ? { timeoutMs: conn.timeoutMs } : {},
			...overrides
		};
	}
	/** 行尾换行串：优先调用参数，其次连接配置的 newline（实时读 conn），再次会话建立时的记录值（临时连接），缺省 crlf（\r\n）。 */
	eolOf(record, override) {
		const conn = this.connectionOf(record);
		const nl = override ?? conn?.newline ?? record.newline ?? "crlf";
		return nl === "lf" ? "\n" : nl === "cr" ? "\r" : "\r\n";
	}
	handleData(record, chunk) {
		record.buffer += chunk;
		if (record.buffer.length > BUFFER_CAP_BYTES) record.buffer = record.buffer.slice(record.buffer.length - BUFFER_CAP_BYTES);
		for (const listener of [...record.subscribers]) listener(chunk);
		this.events.emit({
			type: "output",
			sessionId: record.sessionId,
			data: chunk,
			ts: Date.now()
		});
	}
	handleClose(record, reason) {
		if (record.status === "closed" || record.status === "removed") return;
		record.status = "closed";
		record.closeReason = reason;
		this.notify(record);
	}
	requireRecord(sessionId) {
		const record = this.sessions.get(sessionId);
		if (record === void 0) throw new SessionError("SESSION_NOT_FOUND", `会话不存在: ${sessionId}`);
		return record;
	}
	requireOpen(sessionId) {
		const record = this.requireRecord(sessionId);
		if (record.status !== "open") throw new SessionError("DISCONNECTED", "会话已断开");
		return record;
	}
	snapshot(record) {
		return {
			sessionId: record.sessionId,
			...record.connId !== void 0 ? { connId: record.connId } : {},
			label: record.label,
			target: record.target,
			protocol: record.protocol,
			status: record.status,
			...record.openedAtMs !== void 0 ? { openedAtMs: record.openedAtMs } : {},
			...record.closeReason !== void 0 ? { closeReason: record.closeReason } : {}
		};
	}
	notify(record) {
		const snap = this.snapshot(record);
		for (const listener of [...this.statusListeners]) listener(snap);
		this.events.emit({
			type: "status",
			sessionId: snap.sessionId,
			status: snap.status,
			snapshot: snap,
			ts: Date.now()
		});
	}
};
//#endregion
//#region src/tools.ts
/**
* B6 AI 工具层 —— AI 的六只"手"。
*
* 把六个 tm_* 工具注册进 DSH 的 ctx.tools 给 AI 用；参数校验、结果格式转换、卡片呈现。
* 只调 B4 会话管理器，不直接碰传输层。AI 路径的发送必过命令守卫（guard 传 {}）。
* 会话不按 Agent 隔离——本插件是公共会话池，任何 AI 与人都操作同一批会话。
* @module dsh-terminal-manager/tools
*/
/** 会话快照的 JSON schema（tm_connect / tm_list 复用）。 */
const SESSION_SNAPSHOT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		sessionId: {
			type: "string",
			required: true
		},
		connId: { type: "string" },
		label: {
			type: "string",
			required: true
		},
		target: {
			type: "string",
			required: true
		},
		protocol: {
			type: "string",
			required: true,
			enum: ["ssh", "telnet"]
		},
		status: {
			type: "string",
			required: true,
			enum: [
				"connecting",
				"open",
				"closed",
				"removed"
			]
		},
		openedAtMs: { type: "number" },
		closeReason: { type: "string" }
	}
};
/** tm_send 的输出：已执行完（默认）、发完即回，或批处理。 */
const SEND_RESULT_SCHEMA = { oneOf: [
	{
		type: "object",
		additionalProperties: false,
		properties: {
			kind: {
				type: "string",
				required: true,
				const: "completed"
			},
			output: {
				type: "string",
				required: true
			},
			waitReason: {
				type: "string",
				required: true,
				enum: [
					"quiet",
					"prompt",
					"timeout"
				]
			},
			truncated: {
				type: "boolean",
				required: true
			}
		}
	},
	{
		type: "object",
		additionalProperties: false,
		properties: { kind: {
			type: "string",
			required: true,
			const: "submitted"
		} }
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			kind: {
				type: "string",
				required: true,
				const: "batch"
			},
			results: {
				type: "array",
				required: true,
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						index: {
							type: "number",
							required: true
						},
						command: {
							type: "string",
							required: true
						},
						outcome: {
							type: "string",
							required: true,
							enum: [
								"ok",
								"timeout",
								"skipped",
								"disconnected",
								"aborted"
							]
						},
						output: { type: "string" },
						waitReason: {
							type: "string",
							enum: [
								"quiet",
								"prompt",
								"timeout"
							]
						},
						truncated: { type: "boolean" }
					}
				}
			}
		}
	}
] };
/** tm_send_all 的广播条目。 */
const BROADCAST_ENTRY_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		sessionId: {
			type: "string",
			required: true
		},
		outcome: {
			type: "string",
			required: true,
			enum: [
				"ok",
				"busy",
				"disconnected",
				"error"
			]
		},
		output: { type: "string" },
		waitReason: {
			type: "string",
			enum: [
				"quiet",
				"prompt",
				"timeout"
			]
		},
		code: { type: "string" }
	}
};
/** tm_upload / tm_download 的输出（TransferResult）。 */
const TRANSFER_RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		ok: {
			type: "boolean",
			required: true
		},
		bytes: {
			type: "number",
			required: true
		},
		durationMs: {
			type: "number",
			required: true
		},
		localPath: {
			type: "string",
			description: "下载到本机的实际绝对路径（仅下载返回）"
		}
	}
};
function textOf(content) {
	return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function waitOptions(args) {
	const wait = {
		...args.quietMs !== void 0 ? { quietMs: args.quietMs } : {},
		...args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {}
	};
	return Object.keys(wait).length > 0 ? { wait } : {};
}
/** 文件是否存在（不区分文件/目录；ENOENT → false，其他错误也 → false 不阻塞流程）。 */
async function fileExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
/** FileServiceError / SessionError 带 code；折叠成「CODE: 消息」前缀便于 AI 自纠。 */
function recode(error) {
	if (error instanceof Error && "code" in error) throw new Error(`${String(error.code)}: ${error.message}`);
	throw error instanceof Error ? error : new Error(String(error));
}
/** 连接配置脱敏：删除凭据与 undefined 字段（AI 路径永不返回密码/私钥）。 */
function sanitizeConnection(cfg) {
	const { auth: _auth, ...rest } = cfg;
	return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== void 0));
}
/** 注册 tm_* 工具。需在 ctx.tools / ctx.systemPrompt 就绪后调用。 */
function registerTerminalTools(ctx, deps) {
	const { sessions, store, files, workspaceRoot, localPanel, extensions } = deps;
	ctx.systemPrompt.section({
		name: "tool:term-manager",
		order: 107,
		text: "终端管理插件维护一批与人和 AI 共用的远程设备会话（SSH/Telnet）。先用 tm_list 查看会话；用 tm_connect 连接设备；tm_send 对单个会话发命令并等执行完拿回整段输出（commands 可一次串行执行一批，整批先过守卫预检）；tm_send_all 广播到多台；tm_read 读某会话当前屏幕；不用了 tm_disconnect 断开。同一会话一次只跑一条命令，忙碌会报 SESSION_BUSY。waitReason 为 timeout 不代表命令失败，可用 tm_read 复查。危险命令会被拦截并返回 COMMAND_BLOCKED。文件用 tm_upload / tm_download 传输（仅 SSH 会话）：上传时 localPath 可传文件名（自动在工作目录和面板根目录查找）或绝对路径（必须在两者之一内）；找不到文件时询问用户提供路径；下载时先问用户保存到哪个目录，用户不指定则下载到面板当前目录。工作目录和面板根目录之外的文件无法通过工具上传，需用文件面板手动拖拽。"
	});
	ctx.tools.register(defineTool({
		name: "tm_connect",
		description: "连接一台远程设备，返回会话编号。两种方式二选一：① 传 connId 用已保存的连接；② 传 protocol+host（+port/username/password）建立临时连接（不入库）。",
		parameters: {
			connId: {
				type: "string",
				description: "已保存连接的编号（优先）。省略则用下面的临时连接参数。"
			},
			protocol: {
				type: "string",
				description: "临时连接协议：ssh 或 telnet"
			},
			host: {
				type: "string",
				description: "临时连接 IP 地址"
			},
			port: {
				type: "number",
				description: "临时连接端口（缺省 ssh=22 / telnet=23）"
			},
			username: {
				type: "string",
				description: "SSH 用户名（临时连接）"
			},
			password: {
				type: "string",
				description: "SSH 密码（临时连接）"
			},
			label: {
				type: "string",
				description: "显示名（临时连接）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					...SESSION_SNAPSHOT_SCHEMA.properties,
					banner: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `已连接 ${value.label}（${value.target}，${value.protocol}）会话 ${value.sessionId}\n${value.banner}`
			}]
		},
		async execute(args, _exec) {
			if (args.connId !== void 0 && args.connId.length > 0) {
				const snap = await sessions.connectByConnId(args.connId);
				return {
					...snap,
					banner: sessions.read(snap.sessionId, 200).text
				};
			}
			const protocol = args.protocol;
			if (protocol !== "ssh" && protocol !== "telnet") throw new Error("需要 connId，或临时连接的 protocol（ssh|telnet）");
			const host = args.host?.trim();
			if (host === void 0 || host.length === 0) throw new Error("临时连接需要 host（IP 地址）");
			const port = args.port ?? (protocol === "ssh" ? 22 : 23);
			const existing = sessions.findConnectionByTarget(protocol, host, port);
			if (existing !== void 0) {
				const snap = await sessions.connectByConnId(existing.connId);
				return {
					...snap,
					banner: sessions.read(snap.sessionId, 200).text
				};
			}
			if (protocol === "ssh" && (args.username === void 0 || args.username.length === 0)) throw new Error("SSH 临时连接需要 username");
			const snap = await sessions.connect({
				protocol,
				host,
				port,
				username: args.username,
				...args.password !== void 0 && args.password.length > 0 ? { auth: {
					kind: "password",
					password: args.password
				} } : {},
				label: args.label
			});
			return {
				...snap,
				banner: sessions.read(snap.sessionId, 200).text
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `连接设备 ${args.label ?? args.host ?? args.connId ?? ""}`,
			kind: "execute"
		})
	}));
	ctx.tools.register(defineTool({
		name: "tm_list",
		description: "列出当前所有远程会话及其状态。",
		parameters: {},
		output: {
			schema: {
				type: "array",
				items: SESSION_SNAPSHOT_SCHEMA
			},
			render: (_args, value) => {
				const list = value;
				return [{
					type: "text",
					text: list.length === 0 ? "（无会话）" : list.map((s) => `${s.sessionId} ${s.label} [${s.protocol}] ${s.target} ${s.status}`).join("\n")
				}];
			}
		},
		execute(_args, _exec) {
			return sessions.list();
		},
		presentCall: () => ({
			card: "generic",
			title: "列出会话",
			kind: "read"
		})
	}));
	ctx.tools.register(defineTool({
		name: "tm_send",
		description: "向一个会话发送一条命令（或按 commands 串行执行一批）。默认等待执行完成（静默/提示符/超时判定）后整段返回；wait=immediate 则发完即回（用 tm_read 观察长命令）。危险命令会被拦截；批处理整批预检，命中任一条则整批不执行。",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "会话编号（tm_connect 或 tm_list 返回）"
			},
			command: {
				type: "string",
				description: "要发送的单条命令文本（与 commands 二选一）"
			},
			commands: {
				type: "array",
				items: { type: "string" },
				description: "同会话串行执行的一批命令（与 command 二选一）"
			},
			wait: {
				type: "string",
				description: "complete（默认，等执行完）或 immediate（发完即回）"
			},
			quietMs: {
				type: "number",
				description: "静默判定毫秒数（覆盖连接配置）"
			},
			timeoutMs: {
				type: "number",
				description: "超时兜底毫秒数（覆盖连接配置）"
			}
		},
		output: {
			schema: SEND_RESULT_SCHEMA,
			render: (_args, value) => {
				if (value.kind === "submitted") return [{
					type: "text",
					text: "已发送（未等待执行完成，可用 tm_read 观察）"
				}];
				if (value.kind === "batch") return [{
					type: "text",
					text: value.results.map((r, i) => `────── [命令 ${i + 1}/${value.results.length}] ${r.command} (${r.outcome}) ──────\n${r.output ?? ""}${r.truncated === true ? "\n[输出截断]" : ""}`).join("\n")
				}];
				const v = value;
				return [{
					type: "text",
					text: v.output + (v.truncated ? "\n[输出截断]" : "")
				}];
			}
		},
		async execute(args, exec) {
			if (args.commands !== void 0) {
				if (args.commands.length === 0) throw new Error("commands 不能为空");
				if (args.commands.some((c) => c.length === 0)) throw new Error("commands 不能包含空命令");
				if (args.wait === "immediate") throw new Error("批处理不支持 wait=immediate");
				return {
					kind: "batch",
					results: await sessions.sendBatch(args.sessionId, args.commands, {
						guard: {},
						signal: exec.signal,
						...waitOptions(args)
					})
				};
			}
			if (args.command === void 0 || args.command.length === 0) throw new Error("command 不能为空（或传 commands）");
			if (args.wait === "immediate") {
				await sessions.sendImmediate(args.sessionId, args.command, {
					guard: {},
					signal: exec.signal
				});
				return { kind: "submitted" };
			}
			return {
				kind: "completed",
				...await sessions.sendAndWait(args.sessionId, args.command, {
					guard: {},
					signal: exec.signal,
					...waitOptions(args)
				})
			};
		},
		presentCall(args) {
			const parsed = args;
			return {
				card: "terminal",
				title: parsed.commands !== void 0 ? `批处理 ${parsed.commands.length} 条命令` : parsed.command || "(发送命令)",
				description: `会话 ${parsed.sessionId ?? ""}`
			};
		},
		presentResult(args, result) {
			if (args.wait === "immediate" || result.isError) return void 0;
			const raw = textOf(result.content);
			return raw === void 0 || raw.length === 0 ? void 0 : {
				card: "terminal",
				output: raw
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "tm_send_all",
		description: "广播一条命令到多台设备（默认全部打开的会话），逐台独立执行并汇总结果。sessionIds 用逗号分隔。",
		parameters: {
			command: {
				type: "string",
				required: true,
				description: "要广播的命令文本"
			},
			sessionIds: {
				type: "string",
				description: "逗号分隔的目标会话编号；缺省=全部打开的会话"
			},
			wait: {
				type: "string",
				description: "complete（默认）或 immediate"
			},
			quietMs: {
				type: "number",
				description: "静默判定毫秒数"
			},
			timeoutMs: {
				type: "number",
				description: "超时兜底毫秒数"
			}
		},
		output: {
			schema: {
				type: "array",
				items: BROADCAST_ENTRY_SCHEMA
			},
			render: (_args, value) => {
				return [{
					type: "text",
					text: value.map((e) => `${e.sessionId}: ${e.outcome}${e.output !== void 0 ? `\n${e.output}` : ""}${e.code !== void 0 ? ` [${e.code}]` : ""}`).join("\n---\n")
				}];
			}
		},
		async execute(args, exec) {
			if (args.command.length === 0) throw new Error("command 不能为空");
			const targetIds = args.sessionIds !== void 0 && args.sessionIds.trim() !== "" ? args.sessionIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : void 0;
			if (args.wait === "immediate") {
				const ids = targetIds ?? sessions.list().filter((s) => s.status === "open").map((s) => s.sessionId);
				const entries = [];
				for (const id of ids) try {
					await sessions.sendImmediate(id, args.command, {
						guard: {},
						signal: exec.signal
					});
					entries.push({
						sessionId: id,
						outcome: "ok"
					});
				} catch (error) {
					entries.push({
						sessionId: id,
						outcome: "error",
						code: error instanceof Error && "code" in error ? String(error.code) : "PROTO_ERROR"
					});
				}
				return entries;
			}
			return (await sessions.broadcast(args.command, targetIds, {
				guard: {},
				signal: exec.signal,
				...waitOptions(args)
			})).map((e) => ({
				sessionId: e.sessionId,
				outcome: e.outcome,
				...e.result?.output !== void 0 ? { output: e.result.output } : {},
				...e.result?.waitReason !== void 0 ? { waitReason: e.result.waitReason } : {},
				...e.code !== void 0 ? { code: e.code } : {}
			}));
		},
		presentCall: (args) => ({
			card: "generic",
			title: `广播命令：${args.command}`,
			kind: "execute"
		})
	}));
	ctx.tools.register(defineTool({
		name: "tm_keyboard_mode",
		description: "读取或切换某会话的键盘模式：退格/删除键发送 8（^H）还是 127（DEL）。嵌入式设备与 Linux 默认不同，按键删错字符时用它调整。",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "会话编号"
			},
			action: {
				type: "string",
				required: true,
				enum: ["get", "set"],
				description: "get 读取；set 切换"
			},
			backspace: {
				type: "number",
				description: "退格字节：8 或 127（set 时可选）"
			},
			delete: {
				type: "number",
				description: "删除字节：8 或 127（set 时可选）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					backspace: {
						type: "number",
						required: true
					},
					delete: {
						type: "number",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `键盘模式：退格=${value.backspace}（${value.backspace === 8 ? "^H" : "DEL"}），删除=${value.delete}（${value.delete === 8 ? "^H" : "DEL"}）`
			}]
		},
		execute(args, _exec) {
			if (args.action === "get") {
				const mode = sessions.getKeyboardMode(args.sessionId);
				return {
					backspace: mode.backspaceByte,
					delete: mode.deleteByte
				};
			}
			const mode = sessions.setKeyboardMode(args.sessionId, {
				...args.backspace !== void 0 ? { backspaceByte: args.backspace } : {},
				...args.delete !== void 0 ? { deleteByte: args.delete } : {}
			});
			return {
				backspace: mode.backspaceByte,
				delete: mode.deleteByte
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "键盘模式",
			kind: "read"
		})
	}));
	const portLog = () => {
		const api = extensions?.portLog;
		if (api === void 0) throw new Error("port-log 扩展未启用");
		return api;
	};
	ctx.tools.register(defineTool({
		name: "tm_connection_config",
		description: "查看/新建/修改/删除保存的连接配置。列表结果不含密码/私钥；新建 SSH 连接需要 username 和 password 或 privateKey。",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"list",
					"create",
					"update",
					"remove"
				],
				description: "操作类型"
			},
			id: {
				type: "string",
				description: "连接编号（update/remove 必填）"
			},
			label: {
				type: "string",
				description: "显示名（create 必填）"
			},
			protocol: {
				type: "string",
				enum: ["ssh", "telnet"],
				description: "协议（create 必填）"
			},
			host: {
				type: "string",
				description: "地址（create 必填）"
			},
			port: {
				type: "number",
				description: "端口（缺省 ssh=22 / telnet=23）"
			},
			username: {
				type: "string",
				description: "SSH 用户名"
			},
			password: {
				type: "string",
				description: "SSH 密码（只写；不会回显）"
			},
			privateKey: {
				type: "string",
				description: "SSH 私钥内容或路径（只写）"
			},
			passphrase: {
				type: "string",
				description: "私钥口令（只写）"
			},
			note: {
				type: "string",
				description: "备注"
			},
			favorited: {
				type: "boolean",
				description: "是否收藏"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		async execute(args) {
			await store.ensureLoaded();
			if (args.action === "list") return store.list().map(sanitizeConnection);
			if (args.action === "remove") {
				if (args.id === void 0) throw new Error("remove 需要 id");
				await store.remove(args.id);
				return {
					ok: true,
					id: args.id
				};
			}
			if (args.action === "create") {
				if (args.label === void 0 || args.protocol === void 0 || args.host === void 0) throw new Error("create 需要 label、protocol、host");
				const input = {
					label: args.label,
					protocol: args.protocol,
					host: args.host,
					...args.port !== void 0 ? { port: args.port } : {},
					...args.username !== void 0 ? { username: args.username } : {},
					...args.password !== void 0 ? { auth: {
						kind: "password",
						password: args.password
					} } : {},
					...args.privateKey !== void 0 ? { auth: {
						kind: "key",
						privateKey: args.privateKey,
						...args.passphrase !== void 0 ? { passphrase: args.passphrase } : {}
					} } : {},
					...args.note !== void 0 ? { note: args.note } : {},
					...args.favorited !== void 0 ? { favorited: args.favorited } : {}
				};
				return sanitizeConnection(await store.create(input));
			}
			if (args.id === void 0) throw new Error("update 需要 id");
			const patch = {
				...args.label !== void 0 ? { label: args.label } : {},
				...args.protocol !== void 0 ? { protocol: args.protocol } : {},
				...args.host !== void 0 ? { host: args.host } : {},
				...args.port !== void 0 ? { port: args.port } : {},
				...args.username !== void 0 ? { username: args.username } : {},
				...args.password !== void 0 ? { auth: {
					kind: "password",
					password: args.password
				} } : {},
				...args.privateKey !== void 0 ? { auth: {
					kind: "key",
					privateKey: args.privateKey,
					...args.passphrase !== void 0 ? { passphrase: args.passphrase } : {}
				} } : {},
				...args.note !== void 0 ? { note: args.note } : {},
				...args.favorited !== void 0 ? { favorited: args.favorited } : {}
			};
			return sanitizeConnection(await store.update(args.id, patch));
		},
		presentCall: (args) => ({
			card: "generic",
			title: `连接配置：${args.action}`,
			kind: "read"
		})
	}));
	ctx.tools.register(defineTool({
		name: "tm_mapping",
		description: "管理端口映射（TCP/UDP）：列表、新建、修改、删除、启停、CSV 导入/导出。start 属于高风险动作，执行前先征得用户同意。",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"list",
					"create",
					"update",
					"remove",
					"start",
					"stop",
					"importCsv",
					"exportCsv"
				],
				description: "操作类型"
			},
			id: {
				type: "string",
				description: "映射编号（update/remove/start/stop 必填）"
			},
			protocol: {
				type: "string",
				enum: ["tcp", "udp"],
				description: "协议"
			},
			localAddr: {
				type: "string",
				description: "本地监听地址"
			},
			localPort: {
				type: "number",
				description: "本地监听端口"
			},
			redirectAddr: {
				type: "string",
				description: "目标地址"
			},
			redirectPort: {
				type: "number",
				description: "目标端口"
			},
			autoStart: {
				type: "boolean",
				description: "随插件启动"
			},
			csv: {
				type: "string",
				description: "importCsv 的 CSV 文本"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		async execute(args) {
			const api = portLog();
			await api.ready;
			switch (args.action) {
				case "list": return api.mappings.list();
				case "exportCsv": return { csv: api.mappings.exportCsv() };
				case "importCsv":
					if (args.csv === void 0) throw new Error("importCsv 需要 csv");
					return api.mappings.importCsv(args.csv);
				case "remove":
					if (args.id === void 0) throw new Error("remove 需要 id");
					await api.mappings.remove(args.id);
					return {
						ok: true,
						id: args.id
					};
				case "start":
					if (args.id === void 0) throw new Error("start 需要 id");
					return api.mappings.start(args.id);
				case "stop":
					if (args.id === void 0) throw new Error("stop 需要 id");
					return api.mappings.stop(args.id);
				case "update": {
					if (args.id === void 0) throw new Error("update 需要 id");
					const patch = Object.fromEntries(Object.entries({
						protocol: args.protocol,
						localAddr: args.localAddr,
						localPort: args.localPort,
						redirectAddr: args.redirectAddr,
						redirectPort: args.redirectPort,
						autoStart: args.autoStart
					}).filter(([, value]) => value !== void 0));
					return api.mappings.update(args.id, patch);
				}
				default:
					if (args.protocol === void 0 || args.localAddr === void 0 || args.localPort === void 0 || args.redirectAddr === void 0 || args.redirectPort === void 0) throw new Error("create 需要 protocol、localAddr、localPort、redirectAddr、redirectPort");
					return api.mappings.create({
						protocol: args.protocol,
						localAddr: args.localAddr,
						localPort: args.localPort,
						redirectAddr: args.redirectAddr,
						redirectPort: args.redirectPort,
						autoStart: args.autoStart === true
					});
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: `端口映射：${args.action}`,
			kind: "execute"
		})
	}));
	ctx.tools.register(defineTool({
		name: "tm_share",
		description: "把已打开的会话通过 TCP 共享给其他客户端：列表、开启、停止。start 属于高风险动作，执行前先征得用户同意。",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"list",
					"start",
					"stop"
				],
				description: "操作类型"
			},
			sessionId: {
				type: "string",
				description: "会话编号（start/stop 必填）"
			},
			localAddr: {
				type: "string",
				description: "监听地址（缺省 0.0.0.0）"
			},
			sharePort: {
				type: "number",
				description: "共享端口（缺省 2323）"
			},
			maxClients: {
				type: "number",
				description: "最大客户端数（0=不限）"
			},
			welcomeMessage: {
				type: "string",
				description: "新客户端欢迎语"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		async execute(args) {
			const api = portLog();
			await api.ready;
			if (args.action === "list") return api.shares.list();
			if (args.sessionId === void 0) throw new Error(`${args.action} 需要 sessionId`);
			if (args.action === "stop") {
				await api.shares.stop(args.sessionId);
				return {
					ok: true,
					sessionId: args.sessionId
				};
			}
			return api.shares.start({
				sessionId: args.sessionId,
				localAddr: args.localAddr ?? "0.0.0.0",
				sharePort: args.sharePort ?? 2323,
				maxClients: args.maxClients ?? 0,
				welcomeMessage: args.welcomeMessage ?? ""
			});
		},
		presentCall: (args) => ({
			card: "generic",
			title: `会话共享：${args.action}`,
			kind: "execute"
		})
	}));
	ctx.tools.register(defineTool({
		name: "tm_session_log",
		description: "管理会话日志：列表、开启/修改/停止、默认目录、列目录、常用目录。只记录设备输出，不记录输入。",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"list",
					"start",
					"update",
					"stop",
					"default_dir",
					"list_dir",
					"known_folders"
				],
				description: "操作类型"
			},
			sessionId: {
				type: "string",
				description: "会话编号（start/update/stop 必填）"
			},
			timestamp: {
				type: "boolean",
				description: "每行加时间戳"
			},
			stripAnsi: {
				type: "boolean",
				description: "清理 ANSI 控制序列（默认 true）"
			},
			directory: {
				type: "string",
				description: "日志目录（start 可选）"
			},
			path: {
				type: "string",
				description: "list_dir 要列出的目录"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		async execute(args) {
			const api = portLog();
			await api.ready;
			switch (args.action) {
				case "list": return api.sessionLogs.list();
				case "default_dir": return { directory: api.sessionLogs.getDefaultDirectory() };
				case "known_folders": return api.sessionLogs.knownFolders();
				case "list_dir": return api.sessionLogs.listDir(args.path);
			}
			if (args.sessionId === void 0) throw new Error(`${args.action} 需要 sessionId`);
			if (args.action === "stop") {
				await api.sessionLogs.stop(args.sessionId);
				return {
					ok: true,
					sessionId: args.sessionId
				};
			}
			const options = {
				timestamp: args.timestamp === true,
				stripAnsi: args.stripAnsi !== false
			};
			if (args.action === "update") return api.sessionLogs.update(args.sessionId, options);
			return api.sessionLogs.start(args.sessionId, options, args.directory);
		},
		presentCall: (args) => ({
			card: "generic",
			title: `会话日志：${args.action}`,
			kind: "execute"
		})
	}));
	ctx.tools.register(defineTool({
		name: "tm_read",
		description: "读取某会话当前的屏幕缓冲（不发命令）。",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "会话编号"
			},
			count: {
				type: "number",
				description: "返回最近多少行（缺省 500）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true
					},
					totalLines: {
						type: "number",
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => {
				return [{
					type: "text",
					text: value.text
				}];
			}
		},
		execute(args, _exec) {
			return sessions.read(args.sessionId, args.count ?? 500);
		},
		presentCall: (args) => ({
			card: "generic",
			title: `读取会话 ${args.sessionId}`,
			kind: "read"
		})
	}));
	ctx.tools.register(defineTool({
		name: "tm_disconnect",
		description: "断开会话。",
		parameters: { sessionId: {
			type: "string",
			required: true,
			description: "会话编号"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					sessionId: {
						type: "string",
						required: true
					},
					outcome: {
						type: "string",
						required: true,
						enum: ["closed"]
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `已断开会话 ${value.sessionId}`
			}]
		},
		async execute(args, _exec) {
			await sessions.disconnect(args.sessionId);
			return {
				sessionId: args.sessionId,
				outcome: "closed"
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `断开会话 ${args.sessionId}`,
			kind: "delete"
		})
	}));
	ctx.tools.register(defineTool({
		name: "tm_upload",
		description: "把本机文件上传到远端设备（仅 SSH 会话；Telnet 会话报 UNSUPPORTED）。localPath 可以是绝对路径或文件名：文件名时自动在工作目录和面板根目录下查找（工作目录优先）；绝对路径必须在两者之一内。两处都找不到时询问用户提供具体路径。工作目录和面板根目录之外的文件无法通过此工具上传，需用文件面板手动拖拽。远端同名文件会被覆盖。",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "SSH 会话编号（tm_connect / tm_list 返回）"
			},
			localPath: {
				type: "string",
				required: true,
				description: "本机文件路径：可以是文件名（如 readme.md，自动在工作目录和面板根目录查找）或绝对路径（必须在两者之一内）"
			},
			remotePath: {
				type: "string",
				required: true,
				description: "远端绝对路径（POSIX 风格，如 /root/app.log）"
			}
		},
		output: {
			schema: TRANSFER_RESULT_SCHEMA,
			render: (args, value) => {
				const v = value;
				return [{
					type: "text",
					text: `已上传 ${v.bytes} 字节 → ${args.remotePath}（${v.durationMs}ms）`
				}];
			}
		},
		async execute(args, _exec) {
			if (args.sessionId === void 0 || args.sessionId.length === 0) throw new Error("需要 sessionId（SSH 会话编号）");
			if (args.localPath === void 0 || args.localPath.length === 0) throw new Error("需要 localPath（文件名或绝对路径）");
			if (args.remotePath === void 0 || args.remotePath.length === 0) throw new Error("需要 remotePath（远端绝对路径）");
			const cwdRoot = process.cwd();
			const panelRoot = effectiveRoot(localPanel, workspaceRoot);
			let uploadRoot;
			let absPath;
			if (isAbsolute(args.localPath)) {
				if (isWithin(cwdRoot, args.localPath)) {
					uploadRoot = cwdRoot;
					absPath = args.localPath;
				} else if (isWithin(panelRoot, args.localPath)) {
					uploadRoot = panelRoot;
					absPath = args.localPath;
				} else throw new Error("PATH_OUTSIDE_ROOT: 文件不在工作目录或面板根目录内。工作区外的文件请用文件面板手动拖拽上传。");
			} else {
				const cwdCandidate = join(cwdRoot, args.localPath);
				if (await fileExists(cwdCandidate)) {
					uploadRoot = cwdRoot;
					absPath = cwdCandidate;
				} else {
					const panelCandidate = join(panelRoot, args.localPath);
					if (await fileExists(panelCandidate)) {
						uploadRoot = panelRoot;
						absPath = panelCandidate;
					} else throw new Error(`NOT_FOUND: 在工作目录(${cwdRoot})和面板根目录(${panelRoot})下均未找到 ${args.localPath}，请询问用户提供文件的绝对路径`);
				}
			}
			try {
				return await files.upload({
					sessionId: args.sessionId,
					remotePath: args.remotePath,
					source: {
						kind: "local",
						ref: {
							root: uploadRoot,
							path: absPath
						}
					}
				});
			} catch (error) {
				recode(error);
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: `上传 ${args.localPath ?? ""} → ${args.remotePath ?? ""}`,
			kind: "execute"
		})
	}));
	ctx.tools.register(defineTool({
		name: "tm_download",
		description: "把远端设备文件下载到本机（仅 SSH 会话；Telnet 会话报 UNSUPPORTED）。下载前先问用户保存到哪个目录——用户不指定则下载到本地面板当前目录（调 files.root 可查面板当前目录）。localPath 可省略——省略时自动下载到面板当前目录下（文件名取远端文件名）。如需指定保存位置，必须是面板树根内的绝对路径（面板树根 ≠ DSH 当前目录，先调 files.root 查）。下载完成后可用 files.read 工具读取内容。本机同名文件会被覆盖。",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "SSH 会话编号（tm_connect / tm_list 返回）"
			},
			remotePath: {
				type: "string",
				required: true,
				description: "远端绝对路径（POSIX 风格）"
			},
			localPath: {
				type: "string",
				description: "本机保存位置绝对路径（可选；省略 = 下载到面板当前目录，文件名取远端文件名；填则必须在面板树根内，先调 files.root 查）"
			}
		},
		output: {
			schema: TRANSFER_RESULT_SCHEMA,
			render: (args, value) => {
				const v = value;
				const dest = v.localPath ?? args.localPath ?? "(面板当前目录)";
				return [{
					type: "text",
					text: `已下载 ${args.remotePath}，${v.bytes} 字节 → ${dest}（${v.durationMs}ms）；可用 files.read 读取`
				}];
			}
		},
		async execute(args, _exec) {
			if (args.sessionId === void 0 || args.sessionId.length === 0) throw new Error("需要 sessionId（SSH 会话编号）");
			if (args.remotePath === void 0 || args.remotePath.length === 0) throw new Error("需要 remotePath（远端绝对路径）");
			const cwdRoot = process.cwd();
			const panelRoot = effectiveRoot(localPanel, workspaceRoot);
			const defaultDir = effectiveCwd(localPanel, workspaceRoot);
			const remoteBasename = args.remotePath.split("/").pop() ?? args.remotePath;
			const localPath = args.localPath !== void 0 && args.localPath.length > 0 ? args.localPath : join(defaultDir, remoteBasename);
			let downloadRoot;
			if (isAbsolute(localPath)) {
				if (isWithin(cwdRoot, localPath)) downloadRoot = cwdRoot;
				else if (isWithin(panelRoot, localPath)) downloadRoot = panelRoot;
				else throw new Error("PATH_OUTSIDE_ROOT: 保存路径不在工作目录或面板根目录内。");
			} else downloadRoot = panelRoot;
			try {
				return await files.downloadToLocal({
					sessionId: args.sessionId,
					remotePath: args.remotePath,
					target: {
						root: downloadRoot,
						path: localPath
					}
				});
			} catch (error) {
				recode(error);
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: `下载 ${args.remotePath ?? ""} → ${args.localPath ?? "(面板当前目录)"}`,
			kind: "execute"
		})
	}));
}
//#endregion
//#region src/ws-io.ts
const HEARTBEAT_INTERVAL_MS = 3e4;
/** 一条 WS 连接的会话订阅与帧分发（可直测：注入 ws-like 对象）。 */
var TermIoConnection = class {
	ws;
	sessions;
	subscriptions = /* @__PURE__ */ new Map();
	statusUnsub;
	closed = false;
	constructor(ws, sessions) {
		this.ws = ws;
		this.sessions = sessions;
		this.ws.on("message", this.onMessage);
		this.ws.on("close", this.onClose);
		this.statusUnsub = this.sessions.onStatus((snap) => this.send({
			kind: "status",
			...snap
		}));
	}
	send(frame) {
		if (this.closed) return;
		try {
			this.ws.send(JSON.stringify(frame));
		} catch {}
	}
	onMessage = (raw) => {
		let frame;
		try {
			frame = JSON.parse(typeof raw === "string" ? raw : String(raw));
		} catch {
			return;
		}
		const sid = frame.sessionId;
		switch (frame.kind) {
			case "attach":
				if (this.subscriptions.has(sid)) return;
				try {
					const unsub = this.sessions.subscribe(sid, (data) => this.send({
						kind: "output",
						sessionId: sid,
						data
					}));
					this.subscriptions.set(sid, unsub);
				} catch {}
				break;
			case "detach": {
				const unsub = this.subscriptions.get(sid);
				if (unsub !== void 0) {
					unsub();
					this.subscriptions.delete(sid);
				}
				break;
			}
			case "input":
				try {
					this.sessions.write(sid, frame.data);
				} catch {}
				break;
			case "resize": try {
				this.sessions.resize(sid, frame.cols, frame.rows);
			} catch {}
		}
	};
	onClose = () => {
		this.closed = true;
		for (const unsub of this.subscriptions.values()) unsub();
		this.subscriptions.clear();
		this.statusUnsub();
	};
};
/**
* 注册 /term-io WebSocket 升级路由。返回卸载函数 + 进度帧广播。
* 需 ctx.webServer（host-webserver 提供，web profile 内必就绪）。
*/
function registerWsIo(ctx, sessions) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0) return {
		disposer: () => {},
		broadcastFileProgress: () => {}
	};
	const wss = new WebSocketServer({ noServer: true });
	const connections = /* @__PURE__ */ new Set();
	const heartbeats = /* @__PURE__ */ new Map();
	const handler = (req, socket, head) => {
		const admission = ctx.get("connection")?.admit(req);
		if (admission === void 0 || "rejection" in admission) {
			const status = admission !== void 0 && "rejection" in admission ? admission.rejection : 401;
			socket.write(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Unauthorized"}\r\nConnection: close\r\n\r\n`);
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			const conn = new TermIoConnection(ws, sessions);
			connections.add(conn);
			const timer = setInterval(() => {
				if (ws.readyState !== ws.OPEN) return;
				ws.ping();
			}, HEARTBEAT_INTERVAL_MS);
			heartbeats.set(ws, timer);
			ws.on("close", () => {
				clearInterval(timer);
				heartbeats.delete(ws);
				connections.delete(conn);
			});
		});
	};
	const disposer = ctx.effect(() => webServer.registerUpgrade({
		path: "/term-io",
		handler
	}), "terminal-manager: /term-io WebSocket");
	return {
		disposer: () => {
			disposer?.();
			for (const timer of heartbeats.values()) clearInterval(timer);
			heartbeats.clear();
			for (const ws of wss.clients) ws.close();
			connections.clear();
		},
		/** 广播给所有 /term-io 连接（连接断开由 TermIoConnection.send 自行吞错） */
		broadcastFileProgress: (frame) => {
			for (const conn of connections) conn.send(frame);
		}
	};
}
//#endregion
//#region src/index.ts
/** Cordis 插件名。 */
const name = "terminal-manager";
/** 需要的服务：工具 + 系统提示 + Web 服务器。 */
const inject = [
	"tools",
	"systemPrompt",
	"webServer",
	"connection"
];
/** 连接清单落盘目录（环境变量可覆盖，默认 $DSH_HOME 或 ~/.dsh）。 */
function resolveDataDir(env = process.env) {
	return env.DSH_TERMINAL_MANAGER_DATA ?? join(env.DSH_HOME ?? join(homedir(), ".dsh"), "terminal-manager");
}
/** 挂载插件。`config` 由 DSH 按 Config schema 校验后传入；直接 apply(ctx) 时取默认值。 */
function apply(ctx, config) {
	const cfg = resolveConfig(config);
	const dataDir = resolveDataDir();
	const logger = new AppLogger(join(dataDir, "log"));
	logger.log("info", "plugin.start", { dataDir });
	const store = new ConnectionStore(join(dataDir, "connections.json"));
	const sessions = new SessionManager(store);
	const files = new LocalFileService(sessions, sessions.events);
	const localPanel = createLocalPanelState();
	const uploads = new UploadSessionManager({
		getSftp: (sessionId) => files.getSftp(sessionId),
		dataDir
	});
	const unsubscribeLog = sessions.events.on((event) => {
		if (event.type === "status") logger.log("info", "session.status", {
			sessionId: event.sessionId,
			status: event.status
		});
		else if (event.type === "file") logger.log(event.ok ? "info" : "warn", "session.file", {
			...event.sessionId === void 0 ? {} : { sessionId: event.sessionId },
			op: event.op,
			ok: event.ok,
			...event.bytes === void 0 ? {} : { bytes: event.bytes }
		});
	});
	registerAmbiguityHandling(ctx, sessions);
	registerRemotes(ctx, {
		sessions,
		store,
		config: cfg,
		files,
		localPanel,
		uploads,
		openExternal: (p) => openWithSystem(p),
		broadcastFileProgress: registerWsIo(ctx, sessions).broadcastFileProgress
	});
	const extensions = registerExtensions(ctx, {
		sessions,
		events: sessions.events,
		files,
		dataDir
	});
	registerTerminalTools(ctx, {
		sessions,
		store,
		files,
		workspaceRoot: cfg.workspaceRoot,
		localPanel,
		extensions
	});
	ctx.effect(() => () => {
		unsubscribeLog?.();
		logger.log("info", "plugin.stop");
		logger.close();
		uploads.closeAll();
		sessions.closeAll();
	}, "terminal-manager: 卸载时关闭日志、会话与上传句柄");
}
//#endregion
export { Config, apply, inject, name, resolveDataDir };
