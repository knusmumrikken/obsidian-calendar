# Calendar & Deadlines

An [Obsidian](https://obsidian.md) plugin that shows a mini calendar with deadline overview in a sidebar panel or modal. See overdue tasks, get reminders, and navigate directly to any task with a single click.

Scans your vault for incomplete tasks with due dates and highlights them on the calendar.

## Features

- Mini calendar in the right sidebar with deadline indicators
- Stats bar showing overdue, today, and this week at a glance
- List of upcoming and overdue tasks with relative dates
- **Click any task to open the source file at the exact line**
- Deadline reminders with **snooze** (1 hour or tomorrow morning)
- Overdue badge on the ribbon icon — visible even when the sidebar is closed
- Navigate between months
- Auto-refreshes when notes are saved
- Respects Obsidian's light and dark theme

## Recommended workflow

The plugin scans your entire vault, but the most effective setup is to **keep all tasks with due dates in one central file** — for example `TODO.md`. This gives you a single place to manage deadlines, while notes elsewhere in the vault contain the actual content.

**TODO.md** acts as your control panel:

```markdown
# TODO

- [ ] Send invoice to client 📅 2025-06-15
  → [[Projects/Client Work]]

- [ ] Review pull request 📅 2025-06-12
  → [[Work/Dev]]

- [ ] Buy birthday gift 📅 2025-06-20
  → [[Personal/Family]]

- [ ] Finish report draft due:: 2025-06-18
  → [[Work/Reports/Q2 Report]]
```

Use Obsidian's `[[links]]` on the line below or within the task text to point to the relevant note. When the calendar shows a deadline, click the task to open `TODO.md` at that line — then follow the link to the actual content.

This pattern keeps your notes clean (no due dates scattered everywhere) while giving the plugin a fast, predictable place to scan.

## Supported date formats

The plugin recognizes due dates in the following formats on any incomplete task line:

```
- [ ] Task name 📅 2025-06-15
- [ ] Task name due:: 2025-06-15
- [ ] Task name ⏳ 2025-06-15
```

Dates must be in `YYYY-MM-DD` format. Compatible with the [Tasks plugin](https://github.com/obsidian-tasks-group/obsidian-tasks) and [Dataview](https://github.com/blacksmithgu/obsidian-dataview) date syntax.

## Notifications

Reminders fire as Obsidian toasts while the app is open. Each notification includes:

- **Snooze 1h** — reminds you again in one hour
- **Tomorrow** — reminds you again at 9:00 the next morning
- **Open** — jumps directly to the task in your vault

Configure which offsets to use under **Settings → Community plugins → Calendar & Deadlines**:

| Option | Default |
|--------|---------|
| On the due date | on |
| 1 day before | on |
| 3 days before | off |
| 1 week before | off |

> **Note:** Notifications only work while Obsidian is open. This plugin does not send system push notifications when Obsidian is closed.

## Usage

- Click the **calendar icon** in the ribbon to open the sidebar view
- A **red badge** on the ribbon icon shows the number of overdue tasks
- Click any task in the list to open the file at that line
- Use the command palette (`Ctrl/Cmd + P`) and search for:
  - **Calendar: Open sidebar** — opens the calendar in the right panel
  - **Calendar: Open as modal** — opens the calendar as a floating window

## Installation

### From Obsidian Community Plugins

1. Open **Settings → Community plugins**
2. Click **Browse** and search for "Calendar & Deadlines"
3. Install and enable the plugin

### Manual installation

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](../../releases/latest)
2. Copy them to your vault's `.obsidian/plugins/calendar-deadlines/` folder
3. Enable the plugin in **Settings → Community plugins**

## Compatibility

Requires Obsidian 1.4.0 or higher.
