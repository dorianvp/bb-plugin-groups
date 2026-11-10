// bb-plugin-groups — project groups for the BB sidebar.
//
// Stores named groups of projects in bb.storage.kv and serves them to the
// frontend (a group switcher above bb's own sidebar list) over RPC.
// Every write publishes a realtime signal so all open windows refetch.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectIds: z.array(z.string()),
  /** Small data-URL image shown in the sidebar switcher; null = none. */
  image: z.string().nullable(),
});
export type Group = z.infer<typeof groupSchema>;

/** Client downscales before upload; this is a hard cap on the data URL. */
const IMAGE_MAX_CHARS = 120_000;

export const rpcContract = defineRpcContract({
  groups_list: {
    input: z.null(),
    output: z.object({ groups: z.array(groupSchema) }),
  },
  groups_create: {
    input: z.object({ name: z.string().trim().min(1).max(80) }),
    output: groupSchema,
  },
  groups_rename: {
    input: z.object({
      id: z.string(),
      name: z.string().trim().min(1).max(80),
    }),
    output: groupSchema,
  },
  groups_delete: {
    input: z.object({ id: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  groups_set_membership: {
    input: z.object({
      groupId: z.string(),
      projectId: z.string(),
      member: z.boolean(),
    }),
    output: groupSchema,
  },
  // Fetches an image URL server-side (a browser-to-app drop hands us a URL;
  // fetching it from the renderer would hit CORS) and returns it as a data
  // URL for the client to downscale.
  groups_fetch_image: {
    input: z.object({ url: z.url() }),
    output: z.object({ dataUrl: z.string() }),
  },
  groups_set_image: {
    input: z.object({
      id: z.string(),
      image: z
        .string()
        .startsWith("data:image/")
        .max(IMAGE_MAX_CHARS)
        .nullable(),
    }),
    output: groupSchema,
  },
  // The active group drives the thread-list plugin's `hiddenGroups` preference,
  // so it is server-side state shared by every window. null = all projects.
  groups_active: {
    input: z.null(),
    output: z.object({ activeGroupId: z.string().nullable() }),
  },
  groups_activate: {
    input: z.object({ groupId: z.string().nullable() }),
    output: z.object({ activeGroupId: z.string().nullable() }),
  },
  // Per-project images, shown next to project headers in the sidebar.
  projects_images: {
    input: z.null(),
    output: z.object({ images: z.record(z.string(), z.string()) }),
  },
  projects_set_image: {
    input: z.object({
      projectId: z.string(),
      image: z
        .string()
        .startsWith("data:image/")
        .max(IMAGE_MAX_CHARS)
        .nullable(),
    }),
    output: z.object({ image: z.string().nullable() }),
  },
  // The "Running" section's memory: thread ids seen live, finished entries
  // the user dismissed, plus the section's UI state (collapsed, resized
  // height). Stored server-side so the section survives restarts and
  // reloads and every window starts from the same memory.
  running_state_load: {
    input: z.null(),
    output: z.object({
      seen: z.array(z.string()),
      dismissed: z.array(z.string()),
      collapsed: z.boolean(),
      height: z.number().nullable(),
    }),
  },
  running_state_save: {
    input: z.object({
      seen: z.array(z.string()),
      dismissed: z.array(z.string()),
      collapsed: z.boolean(),
      height: z.number().nullable(),
    }),
    output: z.object({
      seen: z.array(z.string()),
      dismissed: z.array(z.string()),
      collapsed: z.boolean(),
      height: z.number().nullable(),
    }),
  },
});

const GROUPS_CHANGED = "groups-changed";

export default async function plugin(bb: BbPluginApi) {
  // Group records and images are stored apart: the records list stays far
  // below the 256KB-per-value KV cap no matter how many images exist.
  type StoredGroup = Omit<Group, "image">;
  async function readStored(): Promise<StoredGroup[]> {
    const stored = (await bb.storage.kv.get<StoredGroup[]>("groups")) ?? [];
    return stored.map(({ id, name, projectIds }) => ({ id, name, projectIds }));
  }
  async function readImage(id: string): Promise<string | null> {
    return (await bb.storage.kv.get<string>(`image:${id}`)) ?? null;
  }
  async function readGroups(): Promise<Group[]> {
    const stored = await readStored();
    return Promise.all(
      stored.map(async (group) => ({
        ...group,
        image: await readImage(group.id),
      })),
    );
  }
  async function writeStored(groups: StoredGroup[]): Promise<void> {
    await bb.storage.kv.set("groups", groups);
    bb.realtime.publish(GROUPS_CHANGED, { count: groups.length });
  }
  async function withImage(group: StoredGroup): Promise<Group> {
    return { ...group, image: await readImage(group.id) };
  }

  // --- Active group → the thread list's `hiddenGroups` -------------------
  //
  // bb's sidebar list is the builtin `thread-list` plugin. It moves every
  // group named in its `hiddenGroups` preference into the "More" overflow
  // (ids `project:<id>`, `section:<id>`, `machine:<id>`, `threads`), and it
  // publishes each write so open sidebars update live. Selecting a group hides
  // every project outside it. The list the user had before the first switch
  // is kept as a baseline: its non-project entries survive while a group is
  // active, and "All projects" restores it whole.
  const THREAD_LIST = "thread-list";
  const hiddenSchema = z.array(z.string());

  async function readActive(): Promise<string | null> {
    return (await bb.storage.kv.get<string>("active-group")) ?? null;
  }

  async function readHidden(): Promise<string[]> {
    const { preferences } = await bb.sdk.plugins.callRpc({
      pluginId: THREAD_LIST,
      method: "listPreferences",
      input: null,
      outputSchema: z.object({
        preferences: z.object({ hiddenGroups: hiddenSchema }).loose(),
      }),
    });
    return preferences.hiddenGroups;
  }

  async function writeHidden(compute: (current: string[]) => string[]) {
    const value = compute(await readHidden());
    await bb.sdk.plugins.callRpc({
      pluginId: THREAD_LIST,
      method: "setPreference",
      input: { key: "hiddenGroups", value },
      outputSchema: z.object({ key: z.string(), value: z.unknown() }),
    });
  }

  async function applyActive(groupId: string | null): Promise<void> {
    const wasActive = await readActive();
    if (groupId === null) {
      const baseline = await bb.storage.kv.get<string[]>("baseline-hidden");
      if (wasActive !== null) await writeHidden(() => baseline ?? []);
      await bb.storage.kv.delete("active-group");
      await bb.storage.kv.delete("baseline-hidden");
    } else {
      const group = (await readStored()).find((g) => g.id === groupId);
      if (group === undefined) throw new Error(`No group with id ${groupId}`);
      const projects = await bb.sdk.projects.list();
      const members = new Set(group.projectIds);
      if (wasActive === null)
        await bb.storage.kv.set("baseline-hidden", await readHidden());
      await writeHidden((current) => {
        const kept = current.filter((id) => !id.startsWith("project:"));
        const hidden = projects
          .filter((project) => !members.has(project.id))
          .map((project) => `project:${project.id}`);
        return [...kept, ...hidden];
      });
      await bb.storage.kv.set("active-group", groupId);
    }
    bb.realtime.publish(GROUPS_CHANGED, { activeGroupId: groupId });
  }

  /** Re-apply after a membership change or delete touches the active group. */
  async function reapplyIfActive(groupId: string): Promise<void> {
    if ((await readActive()) === groupId) await applyActive(groupId);
  }

  async function createGroup(name: string): Promise<Group> {
    const groups = await readStored();
    const group: StoredGroup = {
      id: randomUUID().slice(0, 8),
      name,
      projectIds: [],
    };
    await writeStored([...groups, group]);
    return { ...group, image: null };
  }
  async function renameGroup(id: string, name: string): Promise<Group | null> {
    const groups = await readStored();
    const group = groups.find((candidate) => candidate.id === id);
    if (group === undefined) return null;
    group.name = name;
    await writeStored(groups);
    return withImage(group);
  }
  async function deleteGroup(id: string): Promise<boolean> {
    const groups = await readStored();
    const remaining = groups.filter((group) => group.id !== id);
    if (remaining.length === groups.length) return false;
    await bb.storage.kv.delete(`image:${id}`);
    await writeStored(remaining);
    return true;
  }
  async function setMembership(
    groupId: string,
    projectId: string,
    member: boolean,
  ): Promise<Group | null> {
    const groups = await readStored();
    const group = groups.find((candidate) => candidate.id === groupId);
    if (group === undefined) return null;
    const has = group.projectIds.includes(projectId);
    if (member && !has) group.projectIds.push(projectId);
    if (!member && has)
      group.projectIds = group.projectIds.filter((id) => id !== projectId);
    await writeStored(groups);
    return withImage(group);
  }
  async function setImage(
    id: string,
    image: string | null,
  ): Promise<Group | null> {
    const groups = await readStored();
    const group = groups.find((candidate) => candidate.id === id);
    if (group === undefined) return null;
    if (image === null) await bb.storage.kv.delete(`image:${id}`);
    else await bb.storage.kv.set(`image:${id}`, image);
    bb.realtime.publish(GROUPS_CHANGED, { count: groups.length });
    return { ...group, image };
  }

  // --- Running sessions state --------------------------------------------
  //
  // The sidebar's "Running" section remembers which threads it has seen live
  // and which finished entries the user dismissed. The ids live in KV, so the
  // memory outlives window reloads and bb restarts. Saves are full-state
  // writes from whichever window changed last; every window re-loads at
  // mount, so they converge. The caps keep a long-running bb from growing
  // the values without bound.
  const RUNNING_IDS_CAP = 500;
  async function readRunningState() {
    const [seen, dismissed, collapsed, height] = await Promise.all([
      bb.storage.kv.get<string[]>("running-seen"),
      bb.storage.kv.get<string[]>("running-dismissed"),
      bb.storage.kv.get<boolean>("running-collapsed"),
      bb.storage.kv.get<number | null>("running-height"),
    ]);
    return {
      seen: seen ?? [],
      dismissed: dismissed ?? [],
      collapsed: collapsed ?? false,
      height: height ?? null,
    };
  }
  async function writeRunningState(input: {
    seen: string[];
    dismissed: string[];
    collapsed: boolean;
    height: number | null;
  }) {
    const state = {
      seen: [...new Set(input.seen)].slice(-RUNNING_IDS_CAP),
      dismissed: [...new Set(input.dismissed)].slice(-RUNNING_IDS_CAP),
      collapsed: input.collapsed,
      height: input.height,
    };
    await bb.storage.kv.set("running-seen", state.seen);
    await bb.storage.kv.set("running-dismissed", state.dismissed);
    await bb.storage.kv.set("running-collapsed", state.collapsed);
    await bb.storage.kv.set("running-height", state.height);
    return state;
  }

  bb.rpc.register(rpcContract, {
    groups_list: async () => ({ groups: await readGroups() }),    groups_create: ({ name }) => createGroup(name),
    groups_rename: async ({ id, name }) => {
      const group = await renameGroup(id, name);
      if (group === null) throw new Error(`No group with id ${id}`);
      return group;
    },
    groups_delete: async ({ id }) => {
      if ((await readActive()) === id) await applyActive(null);
      return { removed: await deleteGroup(id) };
    },
    groups_set_membership: async ({ groupId, projectId, member }) => {
      const group = await setMembership(groupId, projectId, member);
      if (group === null) throw new Error(`No group with id ${groupId}`);
      await reapplyIfActive(groupId);
      return group;
    },
    groups_active: async () => ({ activeGroupId: await readActive() }),
    groups_activate: async ({ groupId }) => {
      await applyActive(groupId);
      return { activeGroupId: groupId };
    },
    groups_fetch_image: async ({ url }) => {
      if (!/^https?:$/.test(new URL(url).protocol))
        throw new Error("Only http(s) image URLs are supported");
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "image/*" },
      });
      if (!response.ok)
        throw new Error(`Image fetch failed: HTTP ${response.status}`);
      const type = response.headers.get("content-type") ?? "";
      if (!type.startsWith("image/"))
        throw new Error(`URL is not an image (content-type ${type || "unknown"})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > 10_000_000)
        throw new Error("Image is larger than 10MB");
      const mime = type.split(";")[0];
      return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
    },
    groups_set_image: async ({ id, image }) => {
      const group = await setImage(id, image);
      if (group === null) throw new Error(`No group with id ${id}`);
      return group;
    },
    projects_images: async () => {
      const keys = await bb.storage.kv.list("project-image:");
      const images: Record<string, string> = {};
      for (const key of keys) {
        const image = await bb.storage.kv.get<string>(key);
        if (image !== undefined)
          images[key.slice("project-image:".length)] = image;
      }
      return { images };
    },
    projects_set_image: async ({ projectId, image }) => {
      if (image === null)
        await bb.storage.kv.delete(`project-image:${projectId}`);
      else await bb.storage.kv.set(`project-image:${projectId}`, image);
      bb.realtime.publish(GROUPS_CHANGED, { projectId });
      return { image };
    },
    running_state_load: async () => readRunningState(),
    running_state_save: async (input) => writeRunningState(input),
  });

  // `bb groups …` lets agents and shells manage groups too. Project ids are
  // the proj_* ids from `bb project list` / bb.sdk.projects.list.
  const usage = [
    "Usage:",
    "  bb groups list [--json]",
    "  bb groups create <name>",
    "  bb groups rename <group-id> <name>",
    "  bb groups delete <group-id>",
    "  bb groups add <group-id> <project-id>",
    "  bb groups remove <group-id> <project-id>",
    "  bb groups use <group-id|all>",
  ].join("\n");
  function formatGroup(group: Group): string {
    const members =
      group.projectIds.length === 0 ? "empty" : group.projectIds.join(", ");
    return `${group.id}  ${group.name}  (${members})`;
  }
  bb.cli.register({
    name: "groups",
    summary: "Manage sidebar project groups",
    commands: [
      {
        name: "list",
        summary: "List groups and their projects",
        usage: "bb groups list [--json]",
      },
      {
        name: "create",
        summary: "Create a group",
        usage: "bb groups create <name>",
      },
      {
        name: "rename",
        summary: "Rename a group",
        usage: "bb groups rename <group-id> <name>",
      },
      {
        name: "delete",
        summary: "Delete a group",
        usage: "bb groups delete <group-id>",
      },
      {
        name: "add",
        summary: "Add a project to a group",
        usage: "bb groups add <group-id> <project-id>",
      },
      {
        name: "remove",
        summary: "Remove a project from a group",
        usage: "bb groups remove <group-id> <project-id>",
      },
      {
        name: "use",
        summary: "Show only one group's projects in the sidebar, or all",
        usage: "bb groups use <group-id|all>",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const notFound = (id: string) => ({
        exitCode: 1,
        stderr: `No group with id ${id}. Run "bb groups list" to see ids.`,
      });
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "list": {
          const groups = await readGroups();
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(groups)
              : groups.length === 0
                ? "No groups."
                : groups.map(formatGroup).join("\n"),
          };
        }
        case "create": {
          const name = args.join(" ").trim();
          if (name === "") break;
          const group = await createGroup(name);
          return { exitCode: 0, stdout: formatGroup(group) };
        }
        case "rename": {
          const [id, ...nameParts] = args;
          const name = nameParts.join(" ").trim();
          if (id === undefined || name === "") break;
          const group = await renameGroup(id, name);
          if (group === null) return notFound(id);
          return { exitCode: 0, stdout: formatGroup(group) };
        }
        case "delete": {
          const [id] = args;
          if (id === undefined || args.length !== 1) break;
          if ((await readActive()) === id) await applyActive(null);
          if (!(await deleteGroup(id))) return notFound(id);
          return { exitCode: 0, stdout: `Deleted ${id}` };
        }
        case "add":
        case "remove": {
          const [groupId, projectId] = args;
          if (groupId === undefined || projectId === undefined) break;
          const group = await setMembership(
            groupId,
            projectId,
            command === "add",
          );
          if (group === null) return notFound(groupId);
          await reapplyIfActive(groupId);
          return { exitCode: 0, stdout: formatGroup(group) };
        }
        case "use": {
          const [id] = args;
          if (id === undefined || args.length !== 1) break;
          const groupId = id === "all" ? null : id;
          if (groupId !== null && !(await readStored()).some((g) => g.id === id))
            return notFound(id);
          await applyActive(groupId);
          return {
            exitCode: 0,
            stdout: groupId === null ? "Showing all projects" : `Showing group ${id}`,
          };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
