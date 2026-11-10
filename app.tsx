// bb-plugin-groups — frontend entry.
//
// Adds a group switcher to the sidebar without touching bb's thread list: the
// `experimental_sidebarNavigation` slot renders bb's own navigation
// (`experimental_Original`) plus one switcher row below it. Selecting a group
// makes the server write the thread-list plugin's `hiddenGroups` preference, which
// moves every other project into the list's "More" overflow. Groups and the
// active group live on the server (server.ts), shared by every window.
//
// The same slot pins a "Running" section between the switcher and the list:
// every thread with live work shows there (duplicated, not moved — each one
// also stays in its project section) and links to its thread.
//
// Management lives in two places sharing one component: a quick dialog from
// the switcher menu, and a full "Groups" nav-panel page. Groups can carry a
// small image (dropped or picked, downscaled client-side to a data URL)
// shown in the switcher.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  DragEvent,
  FormEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  definePluginApp,
  experimental_ProviderIcon,
  experimental_useProviders as useProviders,
  experimental_useSidebarThreads as useSidebarThreads,
  ThreadTitle,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSidebarThreadRowStatuses,
} from "@get-bb/plugin-sdk/app";
import type {
  BbNavigate,
  PluginRpcClient,
  PluginSidebarProject,
  PluginSidebarThread,
  PluginSidebarThreadRowStatus,
  ExperimentalSidebarNavigationProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, Group } from "./server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon, type IconName } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const MANAGE_PATH = "manage";

/** Capitalized alias: JSX treats a lowercase dotted tag as an intrinsic element. */
const ProviderIcon = experimental_ProviderIcon;

function useGroups() {
  const rpc = useRpc<typeof rpcContract>();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const refetch = useCallback(() => {
    rpc.call("groups_list").then(
      (result) => setGroups(result.groups),
      (cause) => toast.error(String(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("groups-changed", refetch);
  return { rpc, groups, refetch };
}

function useActiveGroupId(): [string | null, (next: string | null) => void] {
  const rpc = useRpc<typeof rpcContract>();
  const [active, setActive] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("groups_active").then(
      (result) => setActive(result.activeGroupId),
      () => {},
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("groups-changed", refetch);
  const set = useCallback(
    (next: string | null) => {
      setActive(next);
      rpc.call("groups_activate", { groupId: next }).then(refetch, (cause) => {
        toast.error(String(cause));
        refetch();
      });
    },
    [rpc, refetch],
  );
  return [active, set];
}

/** projectId → data URL, kept current by the same "groups-changed" signal. */
function useProjectImages(): Record<string, string> {
  const rpc = useRpc<typeof rpcContract>();
  const [images, setImages] = useState<Record<string, string>>({});
  const refetch = useCallback(() => {
    rpc.call("projects_images").then(
      (result) => setImages(result.images),
      () => {},
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("groups-changed", refetch);
  return images;
}

/**
 * Put each project's image before its header label inside bb's thread list.
 * The host renders the label as `span.truncate[title]` inside the
 * `div[data-sidebar-project-id]` wrapper; the header precedes the thread
 * rows, so the first match is always the header. A MutationObserver re-applies
 * after the windowed list mounts/unmounts sections. `apply` is idempotent, so
 * the observer firing on our own insertions settles immediately.
 */
function useProjectHeaderImages(images: Record<string, string>) {
  useEffect(() => {
    // bb's thread list is another plugin's component, so watch the document.
    const root = document.body;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const wrappers = root.querySelectorAll<HTMLElement>(
        "[data-sidebar-project-id]",
      );
      for (const wrapper of wrappers) {
        const id = wrapper.getAttribute("data-sidebar-project-id") ?? "";
        const image = images[id] ?? null;
        const label = wrapper.querySelector<HTMLElement>("span.truncate[title]");
        const parent = label?.parentElement ?? null;
        if (label === null || parent === null) continue;
        const existing = parent.querySelector<HTMLImageElement>(
          "img[data-plugin-groups-project-image]",
        );
        if (image === null) {
          existing?.remove();
          continue;
        }
        if (existing !== null) {
          if (existing.src !== image) existing.src = image;
          continue;
        }
        const img = document.createElement("img");
        img.setAttribute("data-plugin-groups-project-image", "");
        img.src = image;
        img.alt = "";
        img.style.cssText =
          "width:16px;height:16px;border-radius:4px;object-fit:cover;flex-shrink:0";
        parent.insertBefore(img, label);
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    };
    apply();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      for (const img of root.querySelectorAll(
        "img[data-plugin-groups-project-image]",
      ))
        img.remove();
    };
  }, [images]);
}

/** Group mutations shared by the dialog and the nav-panel page. */
function useGroupMutations(
  rpc: PluginRpcClient<typeof rpcContract>,
  refetch: () => void,
) {
  const mutate = useCallback(
    (call: Promise<unknown>) => {
      call.then(refetch, (cause) => toast.error(String(cause)));
    },
    [refetch],
  );
  return {
    create: (name: string) => mutate(rpc.call("groups_create", { name })),
    rename: (id: string, name: string) =>
      mutate(rpc.call("groups_rename", { id, name })),
    remove: (id: string) => mutate(rpc.call("groups_delete", { id })),
    setMembership: (groupId: string, projectId: string, member: boolean) =>
      mutate(rpc.call("groups_set_membership", { groupId, projectId, member })),
    setImage: (id: string, image: string | null) =>
      mutate(rpc.call("groups_set_image", { id, image })),
    setProjectImage: (projectId: string, image: string | null) =>
      mutate(rpc.call("projects_set_image", { projectId, image })),
    fetchImage: (url: string) =>
      rpc.call("groups_fetch_image", { url }).then((result) => result.dataUrl),
  };
}
type GroupMutations = ReturnType<typeof useGroupMutations>;

/** Downscale any loadable image source to a small square data URL. */
async function sourceToThumb(src: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not decode the image"));
    el.src = src;
  });
  const SIZE = 96;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("Canvas is unavailable");
  const scale = Math.max(SIZE / img.width, SIZE / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  let data = canvas.toDataURL("image/webp", 0.85);
  if (!data.startsWith("data:image/webp"))
    data = canvas.toDataURL("image/jpeg", 0.8);
  if (data.length > 110_000)
    throw new Error("Image is still too large after downscaling");
  return data;
}

async function fileToThumb(file: File): Promise<string> {
  if (!file.type.startsWith("image/"))
    throw new Error(`"${file.name}" is not an image`);
  const url = URL.createObjectURL(file);
  try {
    return await sourceToThumb(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** First URL in a drop's uri-list/text payload, or null. */
function droppedUrl(dataTransfer: DataTransfer): string | null {
  const raw =
    dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain");
  const first = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#"));
  if (first === undefined) return null;
  if (first.startsWith("data:image/") || /^https?:\/\//.test(first))
    return first;
  return null;
}

function GroupAvatar({
  group,
  className,
}: {
  group: Group | null;
  className?: string;
}) {
  if (group?.image != null) {
    return (
      <img
        src={group.image}
        alt=""
        className={cn("shrink-0 rounded object-cover", className)}
      />
    );
  }
  return (
    <Icon
      name="Layers"
      className={cn("shrink-0 text-muted-foreground", className)}
    />
  );
}

/** Drop target + click-to-pick for a group's or project's image. */
function ImageDrop({
  image,
  name,
  compact = false,
  onSetImage,
  fetchImage,
}: {
  image: string | null;
  name: string;
  compact?: boolean;
  onSetImage: (image: string | null) => void;
  fetchImage: (url: string) => Promise<string>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const report = (cause: unknown) =>
    toast.error(cause instanceof Error ? cause.message : String(cause));
  const run = (thumb: Promise<string>) => {
    setBusy(true);
    thumb
      .then(onSetImage, report)
      .finally(() => setBusy(false));
  };
  const accept = (file: File | undefined) => {
    if (file === undefined) return;
    run(fileToThumb(file));
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    // A drop from the filesystem carries files; a drop from a web browser
    // usually carries only the image's URL (or a data: URL).
    const file = event.dataTransfer.files[0] as File | undefined;
    if (file !== undefined) {
      accept(file);
      return;
    }
    const url = droppedUrl(event.dataTransfer);
    if (url === null) {
      toast.error("Drop an image file or an image from a web page");
      return;
    }
    run(
      url.startsWith("data:image/")
        ? sourceToThumb(url)
        : fetchImage(url).then(sourceToThumb),
    );
  };
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <button
        type="button"
        aria-label={`Set image for ${name} (drop or click)`}
        className={cn(
          "flex items-center justify-center overflow-hidden border border-dashed border-border transition-colors",
          compact ? "size-7 rounded-md" : "size-12 rounded-lg",
          dragOver && "border-primary bg-primary/10",
          image !== null && "border-solid",
        )}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {busy ? (
          <Icon
            name="Loading"
            className="size-4 animate-spin text-muted-foreground"
          />
        ) : image !== null ? (
          <img src={image} alt="" className="size-full object-cover" />
        ) : (
          <Icon
            name="Plus"
            className={cn("text-muted-foreground", compact ? "size-3" : "size-4")}
          />
        )}
      </button>
      {image !== null && !compact ? (
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-destructive"
          onClick={() => onSetImage(null)}
        >
          remove
        </button>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          accept(event.target.files?.[0] ?? undefined);
          event.target.value = "";
        }}
      />
    </div>
  );
}

/** Full group management UI, shared by the dialog and the nav-panel page. */
function GroupManager({
  groups,
  projects,
  projectImages,
  mutations,
}: {
  groups: Group[];
  projects: readonly PluginSidebarProject[];
  projectImages: Record<string, string>;
  mutations: GroupMutations;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newName.trim();
    if (name === "") return;
    mutations.create(name);
    setNewName("");
  };
  return (
    <div className="space-y-4">
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No groups yet. Create one below, then check the projects that belong
          to it. Drop an image on a group to show it in the sidebar switcher.
        </p>
      ) : (
        groups.map((group) => {
          const draft = drafts[group.id] ?? group.name;
          return (
            <div key={group.id} className="rounded-lg border border-border p-3">
              <div className="flex items-start gap-3">
                <ImageDrop
                  image={group.image}
                  name={group.name}
                  onSetImage={(image) => mutations.setImage(group.id, image)}
                  fetchImage={mutations.fetchImage}
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      value={draft}
                      aria-label={`Rename ${group.name}`}
                      className="h-8"
                      onChange={(event) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [group.id]: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        const name = draft.trim();
                        if (name !== "" && name !== group.name)
                          mutations.rename(group.id, name);
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${group.name}`}
                      onClick={() => mutations.remove(group.id)}
                    >
                      <Icon name="Trash2" className="size-4" />
                    </Button>
                  </div>
                  <ul className="space-y-1.5">
                    {projects.map((project) => (
                      <li key={project.id}>
                        <label className="flex cursor-pointer items-center gap-2 text-sm">
                          <Checkbox
                            checked={group.projectIds.includes(project.id)}
                            onCheckedChange={(checked) =>
                              mutations.setMembership(
                                group.id,
                                project.id,
                                checked === true,
                              )
                            }
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {project.name}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          );
        })
      )}
      <form onSubmit={create} className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="New group name"
          aria-label="New group name"
        />
        <Button type="submit" disabled={newName.trim() === ""}>
          <Icon name="Plus" className="size-4" />
          Create
        </Button>
      </form>
      <div>
        <h3 className="mb-2 text-sm font-medium">Project images</h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Shown next to each project's header in the sidebar. Drop an image on
          a square, or click it to pick a file.
        </p>
        <ul className="space-y-1.5">
          {projects.map((project) => {
            const image = projectImages[project.id] ?? null;
            return (
              <li key={project.id} className="flex items-center gap-2">
                <ImageDrop
                  compact
                  image={image}
                  name={project.name}
                  onSetImage={(next) =>
                    mutations.setProjectImage(project.id, next)
                  }
                  fetchImage={mutations.fetchImage}
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {project.name}
                </span>
                {image !== null ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove image for ${project.name}`}
                    onClick={() => mutations.setProjectImage(project.id, null)}
                  >
                    <Icon name="X" className="size-3.5" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function GroupsPage() {
  const { rpc, groups, refetch } = useGroups();
  const { projects } = useSidebarThreads();
  const projectImages = useProjectImages();
  const mutations = useGroupMutations(rpc, refetch);
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          Project groups filter the sidebar via the switcher above the thread
          list. A project can be in any number of groups; the images show in
          the switcher.
        </p>
        <div className="mt-4">
          {groups === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <GroupManager
              groups={groups}
              projects={projects}
              projectImages={projectImages}
              mutations={mutations}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Thread statuses that mean live work: bb's list sorts these as "busy". */
const RUNNING_STATUSES: ReadonlySet<PluginSidebarThread["status"]> = new Set([
  "active",
  "starting",
  "stopping",
]);

/**
 * bb's native sidebar row geometry, lifted from the builtin thread-list
 * plugin: `--bb-sidebar-row-height` (1.75rem; 2.5rem on coarse pointers).
 * The class strings are bb's own, so the section inherits every future
 * adjustment bb makes to them.
 */
const ROW_HEIGHT =
  "h-[var(--bb-sidebar-row-height)] max-md:pointer-coarse:h-[var(--bb-sidebar-row-height-coarse)]";

/**
 * The trailing glyph bb's ThreadStatusGlyph draws for a busy thread, mapped
 * from the host's rolled-up `indicator` (its precedence rules already ran).
 * Class strings are the bundle's own constants (`size-4` default glyph,
 * `text-muted-foreground/50` working color, the 5px success dot), so sizes
 * and shades match the native rows exactly.
 */
function RowGlyph({
  indicator,
  label,
  finished,
  rowStatus,
}: {
  indicator: PluginSidebarThread["indicator"];
  label: string | null;
  finished: boolean;
  rowStatus?: PluginSidebarThreadRowStatus | null;
}) {
  // Native constants: default glyph size and the "working" shade.
  const size = "size-4";
  const spin = cn(
    "pointer-events-none shrink-0 animate-spin motion-reduce:animate-none text-muted-foreground/50",
    size,
  );
  const dimmed = cn(
    "pointer-events-none shrink-0 text-muted-foreground/75",
    size,
  );
  const working = cn(
    "animate-shine-icon pointer-events-none shrink-0 text-muted-foreground/50",
    size,
  );
  // bb's precedence: a row status another plugin set (the PR badge, for
  // example) replaces the glyph unless the thread is actively working, in
  // error, or waiting for input.
  const rowStatusVisible =
    rowStatus !== null &&
    rowStatus !== undefined &&
    indicator !== "runtime" &&
    indicator !== "unread-error" &&
    indicator !== "waiting-for-input";
  if (rowStatusVisible) {
    const status = rowStatus;
    const name = String(status.icon) as unknown as IconName;
    if (status.tone === "running") {
      return (
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-success motion-safe:animate-pulse">
          <Icon
            name={name}
            className={cn("animate-shine-icon pointer-events-none shrink-0", size)}
            aria-label={status.label}
          />
        </span>
      );
    }
    const tone =
      status.tone === "success"
        ? "text-success-foreground"
        : status.tone === "error"
          ? "text-destructive"
          : "text-muted-foreground";
    return (
      <Icon
        name={name}
        className={cn("pointer-events-none shrink-0", size, tone)}
        aria-label={status.label}
      />
    );
  }
  if (finished) {
    // Work ended: keep the informative glyphs, never the spinner.
    if (indicator === "unread-success")
      return <span aria-label={label ?? "Finished"} className="inline-block size-[5px] rounded-full bg-muted-foreground/60 max-md:pointer-coarse:size-1.5" />;
    if (indicator === "unread-error" || indicator === "queued-failed")
      return (
        <Icon
          name="CircleX"
          className={cn("pointer-events-none shrink-0 text-destructive", size)}
          aria-label={label ?? "Error"}
        />
      );
    return (
      <Icon
        name="CircleCheck"
        className={cn("pointer-events-none shrink-0 text-muted-foreground/50", size)}
        aria-label={label ?? "Finished"}
      />
    );
  }
  switch (indicator) {
    case "waiting-for-input":
      return (
        <Icon
          name="CircleQuestion"
          className={dimmed}
          aria-label={label ?? "Waiting for input"}
        />
      );
    case "queued-waiting":
      return (
        <Icon
          name="Clock"
          className={dimmed}
          aria-label={label ?? "Message queued"}
        />
      );
    case "unread-error":
    case "queued-failed":
      return (
        <Icon
          name="CircleX"
          className={cn("pointer-events-none shrink-0 text-destructive", size)}
          aria-label={label ?? "Error"}
        />
      );
    case "workflow":
      return (
        <Icon name="Workflow" className={working} aria-label={label ?? "Workflow"} />
      );
    case "background-agent":
      return (
        <Icon
          name="UserRoundPlus"
          className={working}
          aria-label={label ?? "Background agent"}
        />
      );
    case "background-command":
      return (
        <Icon
          name="Terminal"
          className={working}
          aria-label={label ?? "Background command"}
        />
      );
    case "plan-mode":
      return (
        <Icon
          name="ListTodo"
          className={working}
          aria-label={label ?? "Plan mode"}
        />
      );
    case "unread-success":
      return (
        <span
          aria-label={label ?? "Unread"}
          className="inline-block size-[5px] rounded-full bg-muted-foreground/60 max-md:pointer-coarse:size-1.5"
        />
      );
    default:
      // A running thread without a special indicator: the generic spinner.
      return <Icon name="Loading" className={spin} aria-label={label ?? "Running"} />;
  }
}

/**
 * One running (or finished) thread as a native thread row: same row element
 * classes as the builtin thread-list plugin (row height, text-sm, rounded
 * hover, invisible full-row anchor), the provider icon bb's "Provider icons"
 * preference shows, and the mention-chip `ThreadTitle` — all at the native
 * sizes. The anchor keeps its href (middle-click, copy-link), while plain
 * clicks navigate through bb's router: the host does not route plugin-slot
 * anchors itself. The glyph sits in an absolute flex overlay inside the
 * trailing box, exactly like native rows — inline placement would align it
 * to the text baseline and stretch the row. Finished rows dim instead of
 * disappearing.
 */
function RunningRow({
  thread,
  iconProvider,
  finished,
  navigate,
  onDismiss,
  rowStatus,
  selected,
}: {
  thread: PluginSidebarThread;
  iconProvider: {
    id: string;
    logoUrl?: string | null;
    icon?: { glyph: string } | string | null;
    strings?: { iconTint?: { light: string; dark: string } | null } | null;
  } | null;
  finished: boolean;
  navigate: BbNavigate;
  /** Present on finished rows: clicking the trailing glyph dismisses it. */
  onDismiss?: (threadId: string) => void;
  /** Row status another plugin set (the PR badge); drawn like native rows. */
  rowStatus?: PluginSidebarThreadRowStatus | null;
  /** The thread the route currently shows: bb's selected-row treatment. */
  selected: boolean;
}) {
  return (
    <div
      className={cn(
        "group/thread-row relative flex w-full cursor-pointer items-center gap-2 rounded-md pr-0 text-sm transition-none",
        ROW_HEIGHT,
        selected
          ? "bg-state-active bb-sidebar-selected-row text-sidebar-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        finished && "opacity-60",
      )}
    >
      <a
        href={thread.href}
        draggable={false}
        aria-label={`Open ${thread.displayTitle}`}
        className="absolute inset-0 rounded-md outline-none"
        onClick={(event) => {
          // Left-click without modifiers: route in place like the native list.
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          navigate.toThread(thread.id);
        }}
      />
      {/* Native rows mark the visible content pointer-events-none so every
          click lands on the absolute anchor below; nothing here is itself
          interactive. */}
      <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-1.5 self-stretch">
        {iconProvider !== null ? (
          <span
            role="img"
            aria-label={iconProvider.id}
            className="relative z-30 mr-1.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground"
          >
            <ProviderIcon
              providerKind="agent"
              provider={iconProvider}
              className="size-4"
              aria-hidden="true"
            />
          </span>
        ) : null}
        <span className="bb-thread-title min-w-0 flex-1 truncate" title={thread.displayTitle}>
          <ThreadTitle threadId={thread.id} />
        </span>
      </span>
      <span
        data-sidebar-thread-trailing
        className="pointer-events-none flex shrink-0 items-center gap-0.5"
      >
        <span className="flex h-7 max-md:pointer-coarse:h-9 shrink-0 items-center justify-end">
          <span className="relative h-7 w-7 max-md:pointer-coarse:h-9 max-md:pointer-coarse:w-9 shrink-0">
            {onDismiss !== undefined ? (
              <button
                type="button"
                aria-label={`Dismiss ${thread.displayTitle}`}
                title="Dismiss"
                className="pointer-events-auto absolute inset-0 flex items-center justify-center rounded-md outline-none hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDismiss(thread.id);
                }}
              >
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-subtle-foreground">
                  <RowGlyph indicator={thread.indicator} label={thread.indicatorLabel} finished={finished} rowStatus={rowStatus} />
                </span>
              </button>
            ) : (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span
                  data-sidebar-thread-trailing-indicator
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-subtle-foreground"
                >
                  <RowGlyph indicator={thread.indicator} label={thread.indicatorLabel} finished={finished} rowStatus={rowStatus} />
                </span>
              </span>
            )}
          </span>
        </span>
      </span>
    </div>
  );
}

/**
 * Thread ids this client has seen running. Module-level so the set survives
 * the slot unmounting (route changes), while staying per-window like the
 * drafts state. A thread that leaves the busy statuses but is still known
 * stays pinned as "finished" instead of vanishing mid-glance.
 */
const seenRunning = new Set<string>();

/**
 * Finished threads the user dismissed from the section (via the check
 * button). Survives route changes like `seenRunning`; a thread that starts
 * running again is un-dismissed. Resets on app reload.
 */
const dismissedFinished = new Set<string>();

/**
 * Section UI state (collapsed, resized max height in px). Module-level like
 * the sets above, and persisted server-side through `running_state_save` so
 * collapse and size survive reloads and restarts.
 */
let sectionCollapsed = false;
let sectionHeight: number | null = null;
const RUNNING_DEFAULT_MAX_HEIGHT = 160;
const RUNNING_MIN_HEIGHT = 64;
const RUNNING_MAX_HEIGHT = 600;

/**
 * Every running thread, pinned above bb's thread list and styled as bb's own
 * rows (the class strings come from the builtin thread-list plugin). Purely
 * informational duplication: each entry also stays in its project section,
 * and bb's list is untouched. Threads that finish stay in the section —
 * dimmed, with a done glyph — until bb reloads or the user dismisses them by
 * clicking the glyph; they only leave on their own when the thread is
 * archived, deleted, or hidden. Renders nothing while there is nothing to
 * show. `max-h` + internal scroll keeps a long section from pushing the list
 * out of view.
 */
function RunningSessions({ threads }: { threads: readonly PluginSidebarThread[] }) {
  const navigate = useBbNavigate();
  const { threadId: activeThreadId } = useBbContext();
  const rowStatuses = useSidebarThreadRowStatuses();
  const rpc = useRpc<typeof rpcContract>();
  // Re-render trigger: the seen/dismissed sets live in modules (shared by
  // every mount of this component), so a counter bump is all the state
  // needed. They are persisted server-side (running_state_save) so the
  // section survives window reloads and bb restarts; the flag keeps the
  // save effect from clobbering the stored state with empty sets before
  // the load lands.
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const [persistLoaded, setPersistLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    rpc
      .call("running_state_load")
      .then((state) => {
        if (cancelled) return;
        for (const id of state.seen) seenRunning.add(id);
        for (const id of state.dismissed) dismissedFinished.add(id);
        sectionCollapsed = state.collapsed;
        sectionHeight = state.height;
        setPersistLoaded(true);
        bump();
      }, () => setPersistLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [rpc]);
  const running = threads
    .filter((thread) => !thread.isHidden && RUNNING_STATUSES.has(thread.status))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  // Idempotent bookkeeping; `threads` is a new array on every live update, so
  // the derived finished list below always reflects the freshest membership.
  // A thread that runs again is un-dismissed.
  for (const thread of running) {
    seenRunning.add(thread.id);
    dismissedFinished.delete(thread.id);
  }
  const finished = threads
    .filter(
      (thread) =>
        !thread.isHidden &&
        !thread.isArchived &&
        !RUNNING_STATUSES.has(thread.status) &&
        seenRunning.has(thread.id) &&
        !dismissedFinished.has(thread.id),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  /** Full-state write: additions plus the section's collapse/size. */
  const persistNow = useCallback(() => {
    void rpc
      .call("running_state_save", {
        seen: [...seenRunning],
        dismissed: [...dismissedFinished],
        collapsed: sectionCollapsed,
        height: sectionHeight,
      })
      .catch(() => {});
  }, [rpc]);
  const dismiss = useCallback(
    (threadId: string) => {
      dismissedFinished.add(threadId);
      bump();
      // Dismissals persist immediately: a quit within the debounced save
      // window would otherwise lose them.
      persistNow();
    },
    [bump, persistNow],
  );
  const toggleCollapsed = useCallback(() => {
    sectionCollapsed = !sectionCollapsed;
    bump();
    persistNow();
  }, [bump, persistNow]);
  // Persist seen-id additions (debounced: live updates churn constantly).
  const seenKey = [...seenRunning].sort().join(",");
  const dismissedKey = [...dismissedFinished].sort().join(",");
  useEffect(() => {
    if (!persistLoaded) return;
    const timer = window.setTimeout(() => {
      persistNow();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [persistLoaded, persistNow, seenKey, dismissedKey]);
  // Drag-to-resize: the handle at the section's bottom edge captures the
  // pointer; moving up grows the section, down shrinks it. The height
  // commits on release (one save), not per frame.
  const resizeDrag = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      resizeDrag.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: sectionHeight ?? RUNNING_DEFAULT_MAX_HEIGHT,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );
  const onResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = resizeDrag.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      // The bottom edge follows the cursor: down = taller, up = shorter.
      const next = Math.min(
        RUNNING_MAX_HEIGHT,
        Math.max(RUNNING_MIN_HEIGHT, drag.startHeight + (event.clientY - drag.startY)),
      );
      if (next !== sectionHeight) {
        sectionHeight = next;
        bump();
      }
    },
    [bump],
  );
  const onResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (resizeDrag.current === null) return;
      resizeDrag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      persistNow();
    },
    [persistNow],
  );
  const { providers } = useProviders();
  if (running.length === 0 && finished.length === 0) return null;
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const iconProviderOf = (thread: PluginSidebarThread) => {
    const provider = byId.get(thread.providerId) ?? null;
    return provider === null
      ? null
      : {
          id: provider.id,
          logoUrl: provider.logoUrl,
          icon: provider.icon,
          strings: provider.strings,
        };
  };
  return (
    <div
      className={cn(
        "px-2 pb-1.5 pt-1",
        sectionCollapsed && "border-b border-border",
      )}
    >
      <section aria-label="Running sessions">
        {/* Header mirrors bb's project-section label rows; clicking it
            collapses the section. */}
        <button
          type="button"
          aria-expanded={!sectionCollapsed}
          aria-label={
            sectionCollapsed
              ? "Expand running sessions"
              : "Collapse running sessions"
          }
          onClick={toggleCollapsed}
          className="flex h-7 w-full items-center gap-1 rounded-md pl-1.5 pr-1.5 text-xs font-normal leading-5 text-muted-foreground transition-colors hover:bg-state-hover"
        >
          <Icon
            name="ChevronRight"
            className={cn(
              "size-3 shrink-0 transition-transform duration-150",
              !sectionCollapsed && "rotate-90",
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate text-left" title="Running sessions">
            Running
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center text-xs text-subtle-foreground tabular-nums">
            {running.length}
          </span>
        </button>
        {!sectionCollapsed ? (
          <>
            <div
              className="mt-1 space-y-px overflow-y-auto"
              style={{ maxHeight: sectionHeight ?? RUNNING_DEFAULT_MAX_HEIGHT }}
            >
              {running.map((thread) => (
                <div key={thread.id}>
                  <RunningRow
                    thread={thread}
                    finished={false}
                    navigate={navigate}
                    iconProvider={iconProviderOf(thread)}
                    rowStatus={rowStatuses.get(thread.id) ?? null}
                    selected={thread.id === activeThreadId}
                  />
                </div>
              ))}
              {finished.map((thread) => (
                <div key={thread.id}>
                  <RunningRow
                    thread={thread}
                    finished={true}
                    navigate={navigate}
                    iconProvider={iconProviderOf(thread)}
                    onDismiss={dismiss}
                    rowStatus={rowStatuses.get(thread.id) ?? null}
                    selected={thread.id === activeThreadId}
                  />
                </div>
              ))}
            </div>
            {/* Bottom edge: grab and drag to resize (up = taller). */}
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize running sessions"
              className="-mx-2 mt-1 flex h-2 cursor-ns-resize touch-none items-center transition-colors hover:bg-muted-foreground/20"
              onPointerDown={onResizePointerDown}
              onPointerMove={onResizePointerMove}
              onPointerUp={onResizePointerEnd}
              onPointerCancel={onResizePointerEnd}
            >
              <div className="h-px w-full bg-border" />
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

function SidebarGroupSwitcher({
  experimental_Original: Original,
}: ExperimentalSidebarNavigationProps) {
  const { rpc, groups, refetch } = useGroups();
  const { projects, threads } = useSidebarThreads();
  const navigate = useBbNavigate();
  const mutations = useGroupMutations(rpc, refetch);
  const [activeGroupId, setActiveGroupId] = useActiveGroupId();
  const [manageOpen, setManageOpen] = useState(false);
  const projectImages = useProjectImages();
  useProjectHeaderImages(projectImages);

  const groupList = groups ?? [];
  const activeGroup =
    groupList.find((group) => group.id === activeGroupId) ?? null;

  return (
    <>
      <Original />
      {/* Running sits above the switcher: it spans every group, so it is the
          topmost thing after bb's nav. */}
      <RunningSessions threads={threads} />
      <div className="flex items-center px-2 pt-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 min-w-0 gap-1.5 px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-label="Switch project group"
            >
              <GroupAvatar group={activeGroup} className="size-4" />
              <span className="truncate">
                {activeGroup?.name ?? "All projects"}
              </span>
              <Icon name="ChevronDown" className="size-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuCheckboxItem
              checked={activeGroup === null}
              onCheckedChange={() => setActiveGroupId(null)}
            >
              All projects
            </DropdownMenuCheckboxItem>
            {groupList.length > 0 ? <DropdownMenuSeparator /> : null}
            {groupList.map((group) => (
              <DropdownMenuCheckboxItem
                key={group.id}
                className="gap-2"
                checked={group.id === activeGroupId}
                onCheckedChange={() => setActiveGroupId(group.id)}
              >
                <GroupAvatar group={group} className="size-4" />
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {group.projectIds.length}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setManageOpen(true)}>
              <Icon name="Edit" className="size-4" />
              Quick manage…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate.toPluginPanel(MANAGE_PATH)}>
              <Icon name="Layers" className="size-4" />
              Open groups page
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Manage groups</DialogTitle>
          </DialogHeader>
          <GroupManager
            groups={groupList}
            projects={projects}
            projectImages={projectImages}
            mutations={mutations}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_sidebarNavigation({
    id: "group-switcher",
    title: "Project groups",
    description: "bb's navigation with a project-group switcher below it.",
    component: SidebarGroupSwitcher,
  });
  app.slots.navPanel({
    id: "groups-manage",
    title: "Groups",
    icon: "Layers",
    path: MANAGE_PATH,
    component: GroupsPage,
  });
});
