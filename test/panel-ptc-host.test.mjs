/** Real NodePtc dispatch -> collector WAL -> materialised panel document, without a model. */
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createScope } from "@deepseek-ai/dsh-scope";
import Subprocess from "@deepseek-ai/dsh-subprocess-local";
import Sandbox from "@deepseek-ai/dsh-sandbox-local";
import FileSystem from "@deepseek-ai/dsh-fs-local";
import NodePtc from "@deepseek-ai/dsh-ptc-runtime-node";
import LocalJobs from "@deepseek-ai/dsh-jobs-local";
import { mountSessionBash } from "../lib/session-shells.js";
import { resolveShells } from "../lib/shells.js";
import { createPanelCollector, parseAppendLog, resolvePanelConfig } from "../lib/panel/collect.js";
import { bootHost, shutdown } from "./lib/host.mjs";
import { executeCall, selectExecutor } from "./lib/executor.mjs";
import { assert, test, report, waitFor, withTempDir } from "./lib/harness.mjs";
import * as panel from "../lib/components/panel/index.js";
import { legacyComponent } from "./lib/legacy-component.mjs";

await test("real NodePtc JSON arguments and subcall jobs survive collector persistence", () => withTempDir("panel-ptc-host", async root => {
  const { ctx } = await bootHost();
  const collector = createPanelCollector({
    config: resolvePanelConfig({ textLimit: 64 }),
    env: { DSH_HOME: path.join(tmpdir(), "panel-ptc-synthetic-home") },
  });
  const events = [];
  const session = { id: "panel-ptc", header: { cwd: root }, read() { return events; },
    append(type, data) {
      const event = { type, data, seq: events.length, time: 1000 + events.length };
      events.push(event);
      ctx.emit("session/event", session, event);
      return event;
    },
  };
  const agent = { id: "panel-ptc", session };
  agent.ctx = createScope(ctx, agent).ctx;
  const values = [{ nested: [1, null, { text: "value" }] }, [1, "two"], null, "plain", { long: "x".repeat(200) }];
  try {
    ctx.on("session/event", (owner, event) => collector.observe(owner, event));
    for (const plugin of [Subprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin);
    ctx.provide("sandboxPolicy", { resolve: () => ({ mode: "danger-full-access", workspaceRoot: root, sessionId: session.id }) });
    ctx.tools.register({ name: "panel_probe", description: "Echo JSON for a local panel capture test.",
      parameters: { oneOf: [{ type: "object" }, { type: "array" }, { type: "null" }, { type: "string" }] },
      output: { schema: { type: "object", properties: { ok: { type: "boolean" } } }, render: () => [{ type: "text", text: "probe-result" }] },
      execute: async (_args, exec) => {
        // Fixture job lifecycle uses the actual executor-generated call id, never a guessed id.
        const job = { jobId: "job-" + exec.callId, kind: "fixture", toolCall: { callId: exec.callId, rootCallId: exec.rootCallId } };
        session.append("job/registered", job);
        session.append("job/settled", { ...job, status: "completed" });
        return { ok: true };
      },
    });
    let rejectedExecuted = false;
    ctx.tools.register({ name: "panel_reject", description: "Explicitly reject null to verify failure-event capture.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
      output: { schema: { type: "boolean" }, render: () => [] },
      execute: async args => { rejectedExecuted = true; if (args === null) throw new TypeError("probe explicitly rejects null"); return true; },
    });
    await agent.ctx.plugin({ inject: ["tools", "systemPrompt"], apply(inner) { selectExecutor(inner, "ptc"); } });
    const result = await executeCall(ctx, { agent, name: "run_code", callId: "panel-root",
      arguments: { description: "Generate real panel dispatch events",
        code: "for (const value of " + JSON.stringify(values) + ") { await tools.panel_probe(value); } return true;" },
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    const rejected = await executeCall(ctx, { agent, name: "run_code", callId: "panel-rejected",
      arguments: { description: "Capture null from a rejected tool call", code: "try { await tools.panel_reject(null); } catch {} return true;" },
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(rejected.isError, false, JSON.stringify(rejected));
    assert.equal(rejectedExecuted, true, "the registered probe rejected the actual null input");
    session.append("turn/end", { turn: 1 });
    await collector.flush();
    const starts = events.filter(event => event.type === "tool/ptc-dispatch-start" && event.data.name === "panel_probe");
    assert.deepEqual(starts.map(event => event.data.arguments), values, "arguments are detached JSON from the real executor");
    const paths = collector.pathsFor(session.id);
    const parsed = parseAppendLog(fs.readFileSync(paths.wal, "utf8"));
    assert.equal(parsed.malformed, 0);
    const rejectedRows = parsed.records.filter(row => row.name === "panel_reject");
    assert.deepEqual(rejectedRows.map(row => row.arguments.text), ["null", "null"]);
    assert.equal(rejectedRows.find(row => row.type === "tool/ptc-dispatch").isError, true);
    const persisted = parsed.records.filter(row => row.type === "tool/ptc-dispatch-start" && row.name === "panel_probe");
    assert.equal(persisted.length, values.length);
    for (let i = 0; i < values.length; i++) {
      const full = typeof values[i] === "string" ? values[i] : JSON.stringify(values[i]);
      assert.deepEqual(persisted[i].arguments, { text: full.slice(0, 64), chars: full.length, truncated: full.length > 64, droppedChars: Math.max(0, full.length - 64) });
      assert.equal(persisted[i].callId, starts[i].data.subCallId);
    }
    const document = JSON.parse(fs.readFileSync(paths.data, "utf8"));
    const jobs = document.trace.filter(row => row.kind === "job_registered" || row.kind === "job_settled");
    assert.equal(jobs.length, values.length * 2);
    for (const row of jobs) { assert.equal(row.name, "panel_probe"); assert.equal(row.jobKind, "fixture"); }
    assert.equal(document.trace.find(row => row.kind === "ptc_dispatch_start").text, JSON.stringify(values[0]));
    assert.equal(document.trace.find(row => row.kind === "ptc_dispatch").text, "probe-result");
    assert.equal(document.events.malformed, 0);
  } finally { await shutdown(ctx); await collector.stop(); }
}));

await test("real LocalJobs and ops_bash lifecycle records retain root and sub-call identity", () => withTempDir("panel-real-jobs", async root => {
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  const home = path.join(root, "collector-home");
  const configuredBash = process.env.DSH_OPS_TEST_BASH ? { bashPath: process.env.DSH_OPS_TEST_BASH } : { allowSystemShellFallback: true };
  const bash = resolveShells(configuredBash).bash;
  assert.equal(bash.available, true, JSON.stringify(bash));
  const { ctx } = await bootHost();
  const collector = createPanelCollector({ config: resolvePanelConfig({ capture: true }), env: { DSH_HOME: home } });
  const events = [];
  const session = { id: "panel-real-jobs", header: { cwd: workspace }, read: () => events,
    append(type, data) {
      const event = { type, data, seq: events.length, time: 1_700_000_000_000 + events.length };
      events.push(event); ctx.emit("session/event", session, event); return event;
    },
  };
  const agent = { id: session.id, session };
  const scope = createScope(ctx, agent); agent.ctx = scope.ctx;
  let jobs;
  try {
    ctx.on("session/event", (owner, event) => collector.observe(owner, event));
    for (const plugin of [Subprocess, Sandbox, FileSystem, NodePtc]) await ctx.plugin(plugin);
    await ctx.plugin(inner => inner.provide("sandboxPolicy", { resolve: () => ({ mode: "danger-full-access", workspaceRoot: workspace, sessionId: session.id }) }));
    await ctx.plugin({ inject: ["tools", "systemPrompt"], apply(inner) { mountSessionBash(inner, { publishBashTool: true }, { bash }); } });
    await ctx.serial("agent/created", { agent, source: "startup" });
    await ctx.plugin(inner => inner.provide("agents", { get: id => id === agent.id ? agent : undefined }));
    await ctx.plugin(LocalJobs, {});
    await ctx.plugin(inner => { jobs = inner.get("jobs"); jobs.attachController("panel-real-jobs"); });
    await waitFor(() => ctx.get("tools").get("ops_bash", agent)?.parameters.properties.run_in_background !== undefined, { what: "real jobs-enabled ops_bash" });
    const native = await executeCall(ctx, { name: "ops_bash", callId: "panel-native-root", agent, signal: AbortSignal.timeout(20000),
      arguments: { command: "printf REAL_NATIVE_PANEL", description: "Run the real native panel job", run_in_background: true } });
    assert.equal(native.isError, false, JSON.stringify(native)); assert.equal(native.value.kind, "background", JSON.stringify(native));
    const nativeId = native.value.jobId; const nativeView = await jobs.wait(nativeId, 20000, agent.id);
    assert.equal(nativeView.status, "completed"); assert.equal(nativeView.detail, "exit code: 0");
    assert.ok(jobs.read(nativeId, agent.id).chunks.some(chunk => chunk.text.includes("REAL_NATIVE_PANEL")));
    await agent.ctx.plugin({ inject: ["tools", "systemPrompt"], apply(inner) { selectExecutor(inner, "ptc"); } });
    const ptc = await executeCall(ctx, { name: "run_code", callId: "panel-ptc-root", agent, signal: AbortSignal.timeout(20000),
      arguments: { description: "Run the real PTC panel job", code: "return await tools.ops_bash({ command: 'printf REAL_PTC_PANEL', description: 'Run the real PTC child panel job', run_in_background: true });" } });
    assert.equal(ptc.isError, false, JSON.stringify(ptc));
    const registered = events.filter(event => event.type === "job/registered");
    assert.equal(registered.length, 2, JSON.stringify(registered));
    const ptcId = registered.find(event => event.data.jobId !== nativeId).data.jobId;
    const ptcView = await jobs.wait(ptcId, 20000, agent.id); assert.equal(ptcView.status, "completed");
    assert.equal(ptcView.detail, "exit code: 0");
    assert.ok(jobs.read(ptcId, agent.id).chunks.some(chunk => chunk.text.includes("REAL_PTC_PANEL")));
    assert.equal(ptc.value.result.jobId, ptcId);
    const dispatch = events.find(event => event.type === "tool/ptc-dispatch-start" && event.data.name === "ops_bash");
    assert.ok(dispatch?.data.subCallId); assert.equal(dispatch.data.rootCallId, "panel-ptc-root");
    assert.notEqual(dispatch.data.subCallId, dispatch.data.rootCallId);
    const pair = (id, callId, rootCallId) => {
      const raw = events.filter(event => event.data?.jobId === id);
      assert.equal(raw.length, 2, JSON.stringify(raw));
      assert.deepEqual(raw.map(event => event.type), ["job/registered", "job/settled"]);
      assert.deepEqual(raw.map(event => event.data.toolCall), [{ callId, rootCallId }, { callId, rootCallId }]);
      assert.equal(raw[1].data.status, "completed");
    };
    pair(nativeId, "panel-native-root", "panel-native-root");
    pair(ptcId, dispatch.data.subCallId, "panel-ptc-root");
    session.append("turn/end", { turn: 1 }); await collector.flush();
    const paths = collector.pathsFor(session.id); assert.ok(paths?.wal);
    const parsed = parseAppendLog(fs.readFileSync(paths.wal, "utf8")); assert.equal(parsed.malformed, 0);
    const persistedJobs = parsed.records.filter(row => row.type === "job/registered" || row.type === "job/settled");
    for (const [id, callId] of [[nativeId, "panel-native-root"], [ptcId, dispatch.data.subCallId]]) {
      const rows = persistedJobs.filter(row => row.jobId === id);
      assert.equal(rows.length, 2, JSON.stringify(rows)); assert.deepEqual(rows.map(row => row.callId), [callId, callId]);
      assert.equal(rows[1].status, "completed");
    }
    const document = JSON.parse(fs.readFileSync(paths.data, "utf8"));
    const ptcRows = document.trace.filter(row => row.jobId === ptcId);
    assert.equal(ptcRows.length, 2); assert.ok(ptcRows.every(row => row.name === "ops_bash"));
  } finally {
    if (jobs) for (const job of jobs.list(agent.id)) { if (["running", "stopping"].includes(job.status)) { jobs.kill(job.id, agent.id, "test cleanup"); await jobs.wait(job.id, 10000, agent.id); } }
    await collector.stop(); await scope.dispose(); await shutdown(ctx);
  }
}));


await test("capture disabled keeps all added event categories off disk on a real host", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "dsh-panel-disabled-")));
  const { ctx } = await bootHost({ withTools: false, withSystemPrompt: false });
  try {
    const row = await ctx.plugin(legacyComponent(panel), { capture: false });
    const session = { id: "disabled-events", header: { cwd: root } };
    const categories = ["tool/ptc-dispatch-start", "tool/ptc-dispatch", "job/registered", "job/settled", "agent/inbox/spliced", "todo/write", "turn/end"];
    for (const [seq, type] of categories.entries()) {
      await ctx.serial("session/event", session, { type, seq, time: seq, data: {
        name: "probe", subCallId: "sub", arguments: { secret: "not-retained" },
        content: [{ type: "text", text: "not-retained" }], jobId: "job", kind: "fixture",
        inserted: [{ content: [{ type: "text", text: "not-retained" }] }], todos: [{ status: "pending", content: "not-retained" }],
      } });
    }
    await row.dispose();
    assert.equal(fs.existsSync(path.join(root, ".dsh-ops")), false);
  } finally { await shutdown(ctx); fs.rmSync(root, { recursive: true, force: true }); }
});

report("panel-ptc-host");