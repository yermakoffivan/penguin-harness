/**
 * THE platform: the one hot-swappable unit this build of the server packages.
 *
 * The repo carries exactly one platform — versions exist BETWEEN deployments
 * (this packaged build vs the next bundle pushed over HTTP), not as parallel
 * files. When a future build changes the context shape, it bumps `version`
 * and ships the migrator alongside the new schema; the previous shape lives
 * only in already-parked documents out in the world.
 *
 * PLATFORM LAYER — WHERE POLICY BELONGS. Anything a deployment might want to
 * change (business APIs, what an agent sees, how a capability behaves) goes
 * here rather than in the runtime, and reaches installations by one HTTP push
 * instead of a rebuild. Worth remembering when something looks like it must
 * live in the shell: this code runs INSIDE the server process, so in-process
 * effects (e.g. extending process.env for the shells agents spawn) are
 * deliverable from boot() with no runtime change. See ../hmr/README.md.
 *
 * Tree: platform { terminals: keyed(terminal) } — terminals are the
 * live-state proof (their processes are runtime-owned and survive swaps).
 *
 * This is the business platform that lives on feat/workflow-hmr (the
 * mechanism-only feat/hot-update-mvp packages a bare stub instead — see
 * that branch's platform.ts). Any method added to `methods` below is
 * immediately callable through the generic POST /api/hmr/platform/call
 * dispatch route with no routes.ts change; /terminals* stays wired as a
 * legacy convenience route for this one surface.
 */
import type { Impl, Json, KeyedHandle, Park } from "@prismshadow/penguin-core/kernel";
import { defineIface, keyed, schema, type } from "@prismshadow/penguin-core/kernel";
import { ensureCliOnPath } from "./agent-cli-path.js";
import type { TerminalApi } from "./terminal.js";
import { TerminalIface, terminalImpl } from "./terminal.js";
import { spawnShellResource } from "../hmr/resources.js";
import type { WorkflowApi, WorkflowRegistry, WorkflowTool } from "./workflow.js";
import { WorkflowIface, workflowImpl } from "./workflow.js";

export interface PlatformApi extends Park {
  info(): Json;
  createTerminal(command: string, cwd: string): Promise<{ id: string }>;
  terminals(): KeyedHandle<TerminalApi>;
  workflows(): KeyedHandle<WorkflowApi>;
  workflowTools(): Array<{ workflowId: string; name: string; description: string }>;
  reseedWorkflow(id: string, runCtx: import("./workflow.js").WorkflowRunCtx): void;
}

export type PlatformCtx = { motd: string };

export const PlatformIface = defineIface<PlatformApi, PlatformCtx>({
  name: "platform",
  version: 1,
  context: schema<PlatformCtx>(type({ motd: "string" })),
  methods: [
    "park",
    "info",
    "createTerminal",
    "terminals",
    "workflows",
    "workflowTools",
    "reseedWorkflow",
  ],
  children: { terminals: keyed(TerminalIface), workflows: keyed(WorkflowIface) },
});

export const platformImpl: Impl<PlatformApi, PlatformCtx> = {
  children: { terminals: terminalImpl, workflows: workflowImpl },
  create(ctx, context, children) {
    // "What PATH does the agent's shell see" is policy (see ../hmr/README.md), not
    // mechanism: it belongs here, in-process at platform boot, rather than in the
    // Electron shell that forks the server — that's what makes the fix reach
    // already-deployed machines via a normal hot push instead of a rebuild. Idempotent,
    // so re-running it on every create() (including hot swaps) is harmless.
    ensureCliOnPath();
    const terminals = children.terminals as KeyedHandle<TerminalApi>;
    const workflows = children.workflows as KeyedHandle<WorkflowApi>;
    const tools = new Map<string, { workflowId: string; tool: WorkflowTool }>();
    const registry: WorkflowRegistry = {
      register(workflowId, tool) {
        const existing = tools.get(tool.name);
        if (existing !== undefined) {
          throw new Error(
            `tool '${tool.name}' is already registered by workflow '${existing.workflowId}'`,
          );
        }
        tools.set(tool.name, { workflowId, tool });
        return () => tools.delete(tool.name);
      },
    };
    return {
      park: () => ({ motd: context.motd }),
      info: () => ({
        impl: "packaged",
        ifaceVersion: PlatformIface.version,
        motd: context.motd,
        terminals: terminals.keys(),
        workflows: workflows.keys(),
      }),
      async createTerminal(command, cwd) {
        const id = `term_${Math.random().toString(36).slice(2, 10)}`;
        // Spawn the live resource on the runtime side first; the node only
        // carries its handle id (linear state).
        spawnShellResource(ctx.resources, `proc_${id}`, command, cwd);
        await terminals.add(id, { procId: `proc_${id}`, command, cwd });
        return { id };
      },
      terminals: () => terminals,
      workflows: () => workflows,
      workflowTools: () =>
        [...tools.values()].map(({ workflowId, tool }) => ({
          workflowId,
          name: tool.name,
          description: tool.description,
        })),
      reseedWorkflow(id, runCtx) {
        const workflow = workflows.get(id);
        if (workflow === undefined) throw new Error(`No workflow '${id}'.`);
        workflow.setup(id, registry, runCtx);
      },
    };
  },
};

/** The packaged bundle the runtime boots when nothing has been pushed yet. */
export const packagedPlatform = { id: "packaged", iface: PlatformIface, impl: platformImpl };
