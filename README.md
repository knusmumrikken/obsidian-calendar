# Calendar & Deadlines

An [Obsidian](https://obsidian.md) plugin that shows a mini calendar with deadline overview in a sidebar panel or modal. See overdue tasks, filter by subject, get reminders, and jump straight to any task with a single click.

Scans your vault for tasks with due dates and highlights them on the calendar. No network calls, no telemetry, everything stays local.

Built with Claude Code, reviewed and tested by me.

## Features

- Mini calendar in the right sidebar with deadline indicators
- Stats bar showing overdue, today, and this week at a glance (respects the active subject filter)
- List of upcoming and overdue tasks with relative dates
- **Click any task to open the source file at the exact line**
- **Mark a task done directly from the calendar**
- **Postpone a task by one day** with a single click
- **Collapse the deadline list** when you just want the calendar
- Subject tagging via `#SubjectName`, with colors auto-assigned and editable in settings
- Filter chips per subject, plus a **No tag** chip for untagged tasks and an **All** chip that resets the filter to show everything
- Colored dots per subject on each calendar day (with overflow indicator when a day has several)
- Deadline reminders with **snooze** (1 hour or tomorrow morning)
- Overdue badge on the ribbon icon — visible even when the sidebar is closed, always shows the true total regardless of active filter
- Quick-add: click a date on the calendar, or run **Create task** from the command palette, to add a task without leaving Obsidian
- Optional auto-open of the sidebar on startup
- Navigate between months
- Sidebar view auto-refreshes when notes are saved (the modal view doesn't watch for outside edits, so reopen it to see changes made elsewhere)
- Respects Obsidian's light and dark theme

## Recommended workflow

The plugin scans your entire vault, but the most effective setup is to **keep all tasks with due dates in one central file**, like `TODO.md`. This gives you a single place to manage deadlines, while notes elsewhere in the vault contain the actual content.

**TODO.md** acts as your control panel:

```markdown
# TODO

- [ ] Send invoice to client #Work 📅 2025-06-15
  → [[Projects/Client Work]]

- [ ] Review pull request #Work 📅 2025-06-12
  → [[Work/Dev]]

- [ ] Buy birthday gift #Personal 📅 2025-06-20
  → [[Personal/Family]]

- [ ] Finish report draft #Reports due:: 2025-06-18
  → [[Work/Reports/Q2 Report]]
```

Use Obsidian's `[[links]]` on the line below or within the task text to point to the relevant note. When the calendar shows a deadline, click the task to open `TODO.md` at that line, then follow the link to the actual content.

This pattern keeps your notes clean (no due dates scattered everywhere) while giving the plugin a fast, predictable place to scan.

## Supported task format

The plugin recognizes tasks in the following format on any incomplete task line:

```
- [ ] Task name 📅 2025-06-15
- [ ] Task name due:: 2025-06-15
- [ ] Task name ⏳ 2025-06-15
- [ ] Task name #SubjectName 📅 2025-06-15
```

Dates must be in `YYYY-MM-DD` format. A task can have zero, one, or multiple `#SubjectName` tags. Each one adds the task to that subject's filter and gives it that subject's color on the calendar. Tasks with no subject tag show up under the **No tag** chip so nothing gets lost.

Compatible with the [Tasks plugin](https://github.com/obsidian-tasks-group/obsidian-tasks) and [Dataview](https://github.com/blacksmithgu/obsidian-dataview) date syntax, but this plugin has no dependency on either. It reads and writes plain Markdown directly.

## Subject colors & filtering

The first time a `#SubjectName` tag shows up anywhere in your vault, it's automatically assigned a color. You can change any subject's color under **Settings → Community plugins → Calendar & Deadlines → Subject colors**.

Toggle subject chips above the calendar to filter what's shown. The calendar dots, the deadline list, and the stats bar all update together, and your filter selection is remembered between sessions. Turning off every chip shows nothing rather than falling back to "show all," so click the **All** chip to reset and see everything again.

The ribbon badge is the one exception: it always shows your true total overdue count, regardless of your active filter, since it's meant to be visible even when the panel is closed.

## Commands

Run these from the command palette (`Ctrl/Cmd + P`):

- **Calendar & Deadlines: Open sidebar**: opens the calendar in the right panel
- **Calendar & Deadlines: Open as modal**: opens the calendar as a floating window
- **Calendar & Deadlines: Create task**: quick-add a task from anywhere, without needing the calendar open first

## Notifications

Reminders fire as Obsidian toasts while the app is open. Each notification includes:

- **Snooze 1h**: reminds you again in one hour
- **Tomorrow**: reminds you again at 9:00 the next morning
- **Open**: jumps directly to the task in your vault

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
- Click the checkbox next to a task to mark it done, or the postpone button to push it a day
- Click any date on the calendar, or run **Create task**, to quick-add a task — the Add Task dialog lets you set the description, an optional subject (with autocomplete from subjects you've already used), and the due date, all before saving
- Enable **Auto-open sidebar on startup** in settings if you want it there every time you open Obsidian

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

Requires Obsidian 1.4.0 or higher. Works on desktop and mobile. On iOS, subject autocomplete suggestions may not appear when adding a task, since iOS Safari/WKWebView doesn't support the underlying `<datalist>` element, but you can still type a subject manually.