# bb-plugin-groups

Adds a project-group switcher and a live "Running" sessions section to the
bb sidebar.

## Install

```
bb plugin install https://github.com/dorianvp/bb-plugin-groups
```

Needs bb 0.47+.

- The switcher row sits below bb's sidebar navigation, in the
  `experimental_sidebarNavigation` slot. That slot renders bb's own
  navigation (`experimental_Original`), so nothing else changes.
- bb's thread list is not touched. Selecting a group makes the server write
  the builtin `thread-list` plugin's `hiddenGroups` preference through that
  plugin's RPC. The list moves every project outside the group into its
  "More" overflow and updates live in every window.
- "All projects" restores the `hiddenGroups` list you had before the first
  switch. While a group is active, non-project entries in that list are kept.
- The active group is stored server-side, so every window shows the same one.
- Threads with live work (starting/active/stopping) are pinned in a "Running"
  section at the top of the sidebar, above the group switcher. It's a pure
  view duplication: each entry also stays in its project section, bb's list
  is untouched, and clicking a row opens the thread. Rows replicate bb's
  native thread rows — same row height, provider icon, mention-chip title,
  and trailing status glyph (spinner, waiting, error, PR badge, …) — using
  the builtin thread-list plugin's own class strings, and the row matching
  the open thread is highlighted. Finished sessions stay in the section,
  dimmed; clicking their glyph dismisses them (until they run again). The
  header collapses the section, and the bottom edge drags to resize it;
  collapse state and size persist. All of the section's memory — seen
  threads, dismissals, collapsed, size — is stored server-side, so it
  survives window reloads and bb restarts. It hides itself when there is
  nothing to show.
- The "Groups" page (sidebar nav, or the switcher menu) creates, renames, and
  deletes groups, sets group membership, and sets group and project images.
  Drop an image from Finder or a web browser, or click to pick a file.
- Project images show next to project headers in the thread list. This
  depends on the thread list's markup (`[data-sidebar-project-id]` and the
  header label `span.truncate[title]`). If bb changes it, only the images stop.
- `bb groups` manages groups from a shell; `bb groups use <group-id|all>`
  switches the sidebar.

Develop with `bb plugin dev` in this directory.
