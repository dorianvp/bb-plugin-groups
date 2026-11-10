---
name: project-groups
description: Manage BB sidebar project groups with the `bb groups` CLI. Use when the user asks to create, rename, or delete a project group, or to add or remove a project from a group.
---

# Project groups

The Groups plugin organizes the BB sidebar's projects into named groups. A
project can belong to any number of groups; the sidebar has a switcher to view
one group or all projects.

Commands (project ids come from `bb project list`):

- `bb groups list [--json]` — list groups with their project ids
- `bb groups create <name>` — create a group
- `bb groups rename <group-id> <name>` — rename a group
- `bb groups delete <group-id>` — delete a group (projects are untouched)
- `bb groups add <group-id> <project-id>` — add a project to a group
- `bb groups remove <group-id> <project-id>` — remove a project from a group
- `bb groups use <group-id|all>` — show only one group's projects in the sidebar, or all
