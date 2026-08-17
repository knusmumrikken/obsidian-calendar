import {
  App,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE = "calendar-deadlines-view";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DeadlineTask {
  text: string;
  due: string;       // "YYYY-MM-DD"
  subjects: string[]; // subject tags, e.g. "MAT1100" (from "#MAT1100"); empty when untagged
  filePath: string;
  line: number;
}

interface PluginSettings {
  offsets: number[]; // days before due date to notify
  todoFile: string;  // file to append quick-add tasks to
  subjectColors: Record<string, string>; // subject name -> hex color
  activeSubjectFilter: string[]; // subjects currently hidden from view; empty = show all
  showDeadlineList: boolean; // whether the "Upcoming deadlines" list is expanded
  autoOpenSidebar: boolean;  // open the calendar sidebar automatically on startup
}

interface SavedData {
  settings: PluginSettings;
  notified: string[];
  snoozedUntil: Record<string, number>; // key → timestamp ms
}

const DEFAULT_SETTINGS: PluginSettings = {
  offsets: [0, 1],
  todoFile: "TODO.md",
  subjectColors: {},
  activeSubjectFilter: [],
  showDeadlineList: true,
  autoOpenSidebar: false,
};

const OFFSET_OPTIONS: { days: number; label: string; desc: string }[] = [
  { days: 0, label: "On the due date",  desc: "Notify on the day the task is due" },
  { days: 1, label: "1 day before",     desc: "Notify the day before" },
  { days: 3, label: "3 days before",    desc: "Notify 3 days in advance" },
  { days: 7, label: "1 week before",    desc: "Notify 7 days in advance" },
];

// Pseudo-subject used to represent tasks with no #subject tag, so they get
// their own filter chip and dot instead of being unconditionally shown.
const UNCATEGORIZED = "All";

// ─── Subject colors ───────────────────────────────────────────────────────────

// Obsidian's built-in theme color variables, used as the auto-assignment
// palette so a subject's *initial* color matches the user's theme at the
// moment it's first assigned (light/dark, accent). The resolved hex is then
// frozen into settings.subjectColors — it does not track later theme
// changes, since it must stay a plain editable hex for the color picker.
const SUBJECT_COLOR_VARS = [
  "--color-red",
  "--color-orange",
  "--color-yellow",
  "--color-green",
  "--color-cyan",
  "--color-blue",
  "--color-purple",
  "--color-pink",
];

function hashSubject(subject: string): number {
  let hash = 0;
  for (let i = 0; i < subject.length; i++) {
    hash = (hash * 31 + subject.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function resolveThemeColor(cssVar: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(cssVar).trim();
  return value || "#888888";
}

// Returns the color assigned to a subject. The first time a given subject is
// seen, a color is deterministically picked from the theme palette and
// recorded into `settings.subjectColors` so the same subject always gets the
// same color. Callers must still call plugin.saveSettings() to persist a
// newly-assigned color to disk.
function getSubjectColor(settings: PluginSettings, subject: string): string {
  const existing = settings.subjectColors[subject];
  if (existing) return existing;

  const cssVar = SUBJECT_COLOR_VARS[hashSubject(subject) % SUBJECT_COLOR_VARS.length];
  const color = resolveThemeColor(cssVar);
  settings.subjectColors[subject] = color;
  return color;
}

// ─── Task extraction ──────────────────────────────────────────────────────────

const DUE_RE =
  /📅\s*(\d{4}-\d{2}-\d{2})|due::\s*(\d{4}-\d{2}-\d{2})|⏳\s*(\d{4}-\d{2}-\d{2})/;

// Subject tag characters: ASCII word chars plus Norwegian æøå/ÆØÅ. Keep this
// character class in sync with the one in AddTaskModal's subject sanitizer.
const SUBJECT_TAG_RE = /#([\wæøåÆØÅ]+)/g;

interface ParsedTaskLine {
  text: string;
  due: string;
  subjects: string[];
}

function parseTaskLine(line: string): ParsedTaskLine | null {
  if (!/^[\s]*-\s+\[[ ]\]/.test(line)) return null;
  const match = line.match(DUE_RE);
  if (!match) return null;
  const due = match[1] ?? match[2] ?? match[3];

  const withoutPrefix = line
    .replace(/^[\s]*-\s+\[[ ]\]\s*/, "")
    .replace(DUE_RE, "")
    .replace(/[⏫🔼🔽⏬📅⏳🛫✅❌]/g, "");

  const subjects: string[] = [];
  const text = withoutPrefix
    .replace(SUBJECT_TAG_RE, (_full, tag: string) => {
      subjects.push(tag);
      return "";
    })
    .replace(/\s{2,}/g, " ")
    .trim();

  return { text, due, subjects };
}

async function collectTasks(app: App): Promise<DeadlineTask[]> {
  const tasks: DeadlineTask[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    let content: string;
    try {
      content = await app.vault.cachedRead(file);
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseTaskLine(lines[i]);
      if (!parsed) continue;
      tasks.push({ ...parsed, filePath: file.path, line: i });
    }
  }

  tasks.sort((a, b) => a.due.localeCompare(b.due));
  return tasks;
}

// ─── Open task in editor ──────────────────────────────────────────────────────

async function openTask(app: App, task: DeadlineTask) {
  const file = app.vault.getAbstractFileByPath(task.filePath);
  if (!(file instanceof TFile)) return;
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file);
  const view = leaf.view;
  if (view instanceof MarkdownView) {
    view.editor.setCursor({ line: task.line, ch: 0 });
    view.editor.scrollIntoView(
      { from: { line: task.line, ch: 0 }, to: { line: task.line, ch: 0 } },
      true
    );
  }
}

// ─── Date formatting ──────────────────────────────────────────────────────────

function formatDateYMD(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function todayDateStr(): string {
  return formatDateYMD(new Date());
}

function shiftDateStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return formatDateYMD(d);
}

// ─── Complete / postpone task in place ─────────────────────────────────────────

// Re-reads the file fresh (not from cache) and verifies the target line still
// looks like the expected task before mutating it, since `task.line` was
// captured by a possibly-stale collectTasks() scan.
async function completeTask(app: App, task: DeadlineTask): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(task.filePath);
  if (!(file instanceof TFile)) return false;

  const content = await app.vault.read(file);
  const lines = content.split("\n");
  const line = lines[task.line];
  if (line === undefined || !/^[\s]*-\s+\[ \]/.test(line)) {
    new Notice("Couldn't complete task — the file may have changed. Open it to update manually.");
    return false;
  }

  lines[task.line] = line.replace(/^(\s*-\s+)\[ \]/, "$1[x]") + ` ✅ ${todayDateStr()}`;
  await app.vault.modify(file, lines.join("\n"));
  new Notice("Task completed");
  return true;
}

async function postponeTask(app: App, task: DeadlineTask, days: number): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(task.filePath);
  if (!(file instanceof TFile)) return false;

  const content = await app.vault.read(file);
  const lines = content.split("\n");
  const line = lines[task.line];
  const match = line === undefined ? null : line.match(DUE_RE);
  if (!match) {
    new Notice("Couldn't postpone task — the file may have changed. Open it to update manually.");
    return false;
  }

  const oldDate = match[1] ?? match[2] ?? match[3];
  const newDate = shiftDateStr(oldDate, days);
  // Replace only within the DUE_RE match itself (not line.replace(oldDate, ...),
  // which would corrupt the line if the date string happens to also appear
  // earlier in the task text, e.g. the description mentioning the same date).
  lines[task.line] = line.replace(DUE_RE, m => m.replace(oldDate, newDate));
  await app.vault.modify(file, lines.join("\n"));
  new Notice(`Postponed to ${newDate}`);
  return true;
}

// ─── Calendar renderer ────────────────────────────────────────────────────────

interface RenderCalendarOptions {
  tasks: DeadlineTask[];
  currentMonth: number;
  currentYear: number;
  subjectColors: Record<string, string>;
  activeSubjectFilter: string[]; // subjects currently hidden from view; empty = show all
  showDeadlineList: boolean;
  onNav: (month: number, year: number) => void;
  onTaskClick: (task: DeadlineTask) => void;
  onFilterChange: (hiddenSubjects: string[]) => void;
  onToggleDeadlineList: () => void;
  onCompleteTask: (task: DeadlineTask) => void;
  onPostponeTask: (task: DeadlineTask) => void;
  onDateClick?: (dateStr: string) => void;
}

function renderCalendar(container: HTMLElement, options: RenderCalendarOptions) {
  const {
    tasks,
    currentMonth,
    currentYear,
    subjectColors,
    activeSubjectFilter,
    showDeadlineList,
    onNav,
    onTaskClick,
    onFilterChange,
    onToggleDeadlineList,
    onCompleteTask,
    onPostponeTask,
    onDateClick,
  } = options;

  container.empty();

  const today = new Date();
  const todayMs = new Date(
    today.getFullYear(), today.getMonth(), today.getDate()
  ).getTime();

  // Untagged tasks count as the UNCATEGORIZED pseudo-subject. A task is
  // hidden once every subject it effectively has is hidden.
  const isHiddenByFilter = (t: DeadlineTask) => {
    const effectiveSubjects = t.subjects.length > 0 ? t.subjects : [UNCATEGORIZED];
    return effectiveSubjects.every(s => activeSubjectFilter.includes(s));
  };
  const visibleTasks = tasks.filter(t => !isHiddenByFilter(t));

  // Per date: the task texts (for the aria-label) and the distinct subjects
  // due that day, used to render one colored dot per subject.
  const deadlineDates = new Map<string, { texts: string[]; subjects: string[] }>();
  for (const t of visibleTasks) {
    if (!deadlineDates.has(t.due)) deadlineDates.set(t.due, { texts: [], subjects: [] });
    const entry = deadlineDates.get(t.due)!;
    entry.texts.push(t.text);
    for (const s of t.subjects.length > 0 ? t.subjects : [UNCATEGORIZED]) {
      if (!entry.subjects.includes(s)) entry.subjects.push(s);
    }
  }
  const MAX_VISIBLE_DOTS = 3;

  // ── Stats bar ──────────────────────────────────────────────────────────────
  // Counts respect the subject filter (unlike the ribbon badge, which
  // intentionally always shows the unfiltered total — see updateBadge()).
  const overdueCount  = visibleTasks.filter(t => new Date(t.due + "T00:00:00").getTime() < todayMs).length;
  const todayCount    = visibleTasks.filter(t => new Date(t.due + "T00:00:00").getTime() === todayMs).length;
  const weekCount     = visibleTasks.filter(t => {
    const d = Math.ceil((new Date(t.due + "T00:00:00").getTime() - todayMs) / 86400000);
    return d > 0 && d <= 7;
  }).length;

  const stats = container.createDiv({ cls: "cdp-stats" });
  const addStat = (value: number, label: string, cls: string) => {
    if (value === 0) return;
    const span = stats.createSpan({ cls: `cdp-stat ${cls}` });
    span.createSpan({ text: String(value), cls: "cdp-stat-num" });
    span.createSpan({ text: ` ${label}` });
  };
  addStat(overdueCount, "overdue",    "cdp-stat-overdue");
  addStat(todayCount,   "today",      "cdp-stat-today");
  addStat(weekCount,    "this week",  "cdp-stat-week");
  if (overdueCount === 0 && todayCount === 0 && weekCount === 0) {
    stats.createSpan({ text: "No upcoming deadlines", cls: "cdp-stat cdp-stat-clear" });
  }
  if (activeSubjectFilter.length > 0) {
    stats.createSpan({
      text: `${activeSubjectFilter.length} subject${activeSubjectFilter.length > 1 ? "s" : ""} hidden`,
      cls: "cdp-stat cdp-stat-filtered",
    });
  }

  // ── Header ─────────────────────────────────────────────────────────────────
  const header = container.createDiv({ cls: "cdp-header" });

  const prevBtn = header.createEl("button", { text: "‹", cls: "cdp-nav" });
  prevBtn.addEventListener("click", () => {
    let m = currentMonth - 1, y = currentYear;
    if (m < 0) { m = 11; y--; }
    onNav(m, y);
  });

  const MONTHS = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December",
  ];
  header.createEl("h3", {
    text: `${MONTHS[currentMonth]} ${currentYear}`,
    cls: "cdp-month-title",
  });

  const nextBtn = header.createEl("button", { text: "›", cls: "cdp-nav" });
  nextBtn.addEventListener("click", () => {
    let m = currentMonth + 1, y = currentYear;
    if (m > 11) { m = 0; y++; }
    onNav(m, y);
  });

  // ── Subject filter chips ──────────────────────────────────────────────────
  const allSubjects = [...new Set(tasks.flatMap(t => t.subjects))].sort((a, b) =>
    a.localeCompare(b)
  );
  if (tasks.some(t => t.subjects.length === 0)) {
    allSubjects.push(UNCATEGORIZED);
  }
  if (allSubjects.length > 0) {
    const filterRow = container.createDiv({ cls: "cdp-filter-row" });
    for (const subject of allSubjects) {
      const isHidden = activeSubjectFilter.includes(subject);
      const chip = filterRow.createEl("button", {
        text: subject,
        cls: `cdp-chip${isHidden ? " cdp-chip-hidden" : ""}`,
      });
      chip.style.setProperty("--cdp-chip-color", subjectColors[subject] ?? "var(--text-faint)");
      chip.setAttribute("title", isHidden ? `Show ${subject}` : `Hide ${subject}`);
      chip.addEventListener("click", () => {
        const next = isHidden
          ? activeSubjectFilter.filter(s => s !== subject)
          : [...activeSubjectFilter, subject];
        onFilterChange(next);
      });
    }
  }

  // ── Grid ───────────────────────────────────────────────────────────────────
  const grid = container.createDiv({ cls: "cdp-grid" });
  for (const d of ["Mo","Tu","We","Th","Fr","Sa","Su"]) {
    grid.createDiv({ text: d, cls: "cdp-dow" });
  }

  const firstDay = new Date(currentYear, currentMonth, 1);
  let startOffset = firstDay.getDay() - 1;
  if (startOffset < 0) startOffset = 6;

  const daysInPrev = new Date(currentYear, currentMonth, 0).getDate();
  for (let i = startOffset - 1; i >= 0; i--) {
    grid.createDiv({ text: `${daysInPrev - i}`, cls: "cdp-day cdp-other-month" });
  }

  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const isToday =
      d === today.getDate() &&
      currentMonth === today.getMonth() &&
      currentYear === today.getFullYear();
    const hasDeadline = deadlineDates.has(dateStr);

    const cls = [
      "cdp-day",
      "cdp-current-month",
      isToday ? "cdp-today" : "",
      hasDeadline ? "cdp-has-deadline" : "",
    ].filter(Boolean).join(" ");

    const cell = grid.createDiv({ text: `${d}`, cls });
    if (hasDeadline) {
      const entry = deadlineDates.get(dateStr)!;
      cell.setAttribute("aria-label", entry.texts.join(", "));

      const dotsRow = cell.createDiv({ cls: "cdp-dots" });
      const shownSubjects = entry.subjects.slice(0, MAX_VISIBLE_DOTS);
      for (const subject of shownSubjects) {
        const dot = dotsRow.createSpan({ cls: "cdp-dot" });
        dot.style.setProperty(
          "--cdp-dot-color",
          subject === UNCATEGORIZED ? "var(--text-faint)" : subjectColors[subject] ?? "var(--text-faint)"
        );
      }
      const overflow = entry.subjects.length - shownSubjects.length;
      if (overflow > 0) {
        dotsRow.createSpan({ text: `+${overflow}`, cls: "cdp-dot-overflow" });
      }
    }
    if (onDateClick) {
      cell.addClass("cdp-day-addable");
      cell.setAttribute("title", `Add task on ${dateStr}`);
      cell.addEventListener("click", () => onDateClick(dateStr));
    }
  }

  const totalCells = startOffset + daysInMonth;
  const trailing = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= trailing; i++) {
    grid.createDiv({ text: `${i}`, cls: "cdp-day cdp-other-month" });
  }

  // ── Deadlines list ─────────────────────────────────────────────────────────
  container.createEl("hr", { cls: "cdp-divider" });
  const section = container.createDiv({ cls: "cdp-deadlines" });

  const sectionHeader = section.createDiv({ cls: "cdp-section-header" });
  sectionHeader.createEl("h4", { text: "Upcoming deadlines", cls: "cdp-section-title" });
  const toggleBtn = sectionHeader.createEl("button", {
    text: showDeadlineList ? "▾" : "▸",
    cls: "cdp-section-toggle",
  });
  toggleBtn.setAttribute("aria-label", showDeadlineList ? "Collapse list" : "Expand list");
  toggleBtn.addEventListener("click", () => onToggleDeadlineList());

  if (!showDeadlineList) return;

  const upcoming = visibleTasks.slice(0, 10);
  if (upcoming.length === 0) {
    section.createDiv({ text: "No upcoming deadlines", cls: "cdp-empty" });
    return;
  }

  for (const item of upcoming) {
    const row = section.createDiv({ cls: "cdp-item cdp-item-clickable" });
    row.setAttribute("title", `Open in ${item.filePath}`);
    row.addEventListener("click", () => onTaskClick(item));

    const checkbox = row.createEl("input", { type: "checkbox", cls: "cdp-item-checkbox" });
    checkbox.setAttribute("title", "Mark as done");
    checkbox.addEventListener("click", (e) => {
      // Prevent the native checked-state toggle: onCompleteTask() may fail
      // (e.g. the file changed underneath us), and on success the row is
      // removed by a redraw anyway, so there's nothing for the checkbox
      // itself to visually reflect either way.
      e.preventDefault();
      e.stopPropagation();
      onCompleteTask(item);
    });

    const dueDate = new Date(item.due + "T00:00:00");
    const diffDays = Math.ceil((dueDate.getTime() - todayMs) / 86400000);

    let label = "";
    let labelCls = "cdp-item-date";
    if (diffDays < 0) {
      label = `${Math.abs(diffDays)}d ago`;
      labelCls += " cdp-overdue";
    } else if (diffDays === 0) {
      label = "Today";
      labelCls += " cdp-today-due";
    } else if (diffDays <= 3) {
      label = `in ${diffDays}d`;
      labelCls += " cdp-soon";
    } else {
      label = `in ${diffDays}d`;
    }

    row.createDiv({ text: label, cls: labelCls });
    row.createDiv({ text: item.text, cls: "cdp-item-text" });

    const postponeBtn = row.createEl("button", { text: "+1d", cls: "cdp-item-postpone" });
    postponeBtn.setAttribute("title", "Postpone by 1 day");
    postponeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onPostponeTask(item);
    });
  }
}

// ─── Sidebar View ─────────────────────────────────────────────────────────────

class CalendarView extends ItemView {
  private plugin: CalendarDeadlinesPlugin;
  private tasks: DeadlineTask[] = [];
  private month: number;
  private year: number;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CalendarDeadlinesPlugin) {
    super(leaf);
    this.plugin = plugin;
    const now = new Date();
    this.month = now.getMonth();
    this.year = now.getFullYear();
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Calendar & Deadlines"; }
  getIcon() { return "calendar-days"; }

  async onOpen() {
    this.tasks = await collectTasks(this.app);
    await this.plugin.ensureSubjectColors(this.tasks);
    this.redraw();

    this.registerEvent(
      this.app.vault.on("modify", () => {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refresh(), 1000);
      })
    );
  }

  private redraw() {
    const content = this.containerEl.children[1] as HTMLElement;
    renderCalendar(content, {
      tasks: this.tasks,
      currentMonth: this.month,
      currentYear: this.year,
      subjectColors: this.plugin.settings.subjectColors,
      activeSubjectFilter: this.plugin.settings.activeSubjectFilter,
      showDeadlineList: this.plugin.settings.showDeadlineList,
      onNav: (m, y) => { this.month = m; this.year = y; this.redraw(); },
      onTaskClick: (task) => openTask(this.app, task),
      onFilterChange: async (hiddenSubjects) => {
        this.plugin.settings.activeSubjectFilter = hiddenSubjects;
        await this.plugin.saveSettings();
        this.redraw();
      },
      onToggleDeadlineList: async () => {
        this.plugin.settings.showDeadlineList = !this.plugin.settings.showDeadlineList;
        await this.plugin.saveSettings();
        this.redraw();
      },
      onCompleteTask: async (task) => {
        if (await completeTask(this.app, task)) await this.refresh();
      },
      onPostponeTask: async (task) => {
        if (await postponeTask(this.app, task, 1)) await this.refresh();
      },
      onDateClick: (dateStr) => new AddTaskModal(this.app, this.plugin, dateStr).open(),
    });
  }

  async refresh() {
    this.tasks = await collectTasks(this.app);
    await this.plugin.ensureSubjectColors(this.tasks);
    this.redraw();
  }

  async onClose() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

// ─── Modal ────────────────────────────────────────────────────────────────────

class CalendarModal extends Modal {
  private plugin: CalendarDeadlinesPlugin;
  private tasks: DeadlineTask[];
  private month: number;
  private year: number;

  constructor(app: App, plugin: CalendarDeadlinesPlugin, tasks: DeadlineTask[]) {
    super(app);
    this.plugin = plugin;
    this.tasks = tasks;
    const now = new Date();
    this.month = now.getMonth();
    this.year = now.getFullYear();
  }

  onOpen() {
    this.titleEl.setText("Calendar & Deadlines");
    this.redraw();
  }

  private async refreshTasks() {
    this.tasks = await collectTasks(this.app);
    await this.plugin.ensureSubjectColors(this.tasks);
    this.redraw();
  }

  private redraw() {
    renderCalendar(this.contentEl, {
      tasks: this.tasks,
      currentMonth: this.month,
      currentYear: this.year,
      subjectColors: this.plugin.settings.subjectColors,
      activeSubjectFilter: this.plugin.settings.activeSubjectFilter,
      showDeadlineList: this.plugin.settings.showDeadlineList,
      onNav: (m, y) => { this.month = m; this.year = y; this.redraw(); },
      onTaskClick: (task) => { this.close(); openTask(this.app, task); },
      onFilterChange: async (hiddenSubjects) => {
        this.plugin.settings.activeSubjectFilter = hiddenSubjects;
        await this.plugin.saveSettings();
        this.redraw();
      },
      onToggleDeadlineList: async () => {
        this.plugin.settings.showDeadlineList = !this.plugin.settings.showDeadlineList;
        await this.plugin.saveSettings();
        this.redraw();
      },
      onCompleteTask: async (task) => {
        if (await completeTask(this.app, task)) await this.refreshTasks();
      },
      onPostponeTask: async (task) => {
        if (await postponeTask(this.app, task, 1)) await this.refreshTasks();
      },
      onDateClick: (dateStr) => { this.close(); new AddTaskModal(this.app, this.plugin, dateStr).open(); },
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Add Task Modal ───────────────────────────────────────────────────────────

class AddTaskModal extends Modal {
  private plugin: CalendarDeadlinesPlugin;
  private date: string;

  constructor(app: App, plugin: CalendarDeadlinesPlugin, date?: string) {
    super(app);
    this.plugin = plugin;
    this.date = date ?? todayDateStr();
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText("Add task");

    let taskText = "";
    let subject = "";

    const addTask = async () => {
      const trimmed = taskText.trim();
      if (!trimmed) return;
      await this.appendTask(trimmed, subject);
      this.close();
    };

    new Setting(contentEl)
      .setName("Task description")
      .addText(text => {
        text
          .setPlaceholder("e.g. Send invoice to client")
          .onChange(v => { taskText = v; });
        text.inputEl.style.width = "100%";
        text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") { e.preventDefault(); void addTask(); }
        });
        setTimeout(() => text.inputEl.focus(), 50);
      });

    const knownSubjects = Object.keys(this.plugin.settings.subjectColors).sort((a, b) =>
      a.localeCompare(b)
    );

    new Setting(contentEl)
      .setName("Subject")
      .setDesc("Optional #SubjectName tag. Leave blank to leave it untagged.")
      .addText(text => {
        text.setPlaceholder("e.g. MAT1100");
        if (knownSubjects.length > 0) {
          // Native datalist: suggests existing subjects while still allowing
          // free text for a brand-new one.
          text.inputEl.setAttribute("list", "cdp-subject-suggestions");
          const datalist = contentEl.createEl("datalist", { attr: { id: "cdp-subject-suggestions" } });
          for (const s of knownSubjects) datalist.createEl("option", { attr: { value: s } });
        }
        text.onChange(v => {
          // Keep in sync with SUBJECT_TAG_RE's character class.
          subject = v.trim().replace(/[^\wæøåÆØÅ]/g, "");
        });
      });

    new Setting(contentEl)
      .setName("Due date")
      .addText(text => {
        text.setValue(this.date);
        text.inputEl.type = "date";
        text.inputEl.addEventListener("change", () => {
          // A native date input's value is always YYYY-MM-DD (or empty if
          // cleared) — only accept it when non-empty so `this.date` always
          // stays a valid date collectTasks() can parse.
          if (text.inputEl.value) this.date = text.inputEl.value;
        });
      });

    new Setting(contentEl)
      .addButton(btn =>
        btn.setButtonText("Add task")
          .setCta()
          .onClick(() => void addTask())
      );
  }

  private async appendTask(text: string, subject: string) {
    // Normalize the user-configured path once here: handles backslashes on
    // Windows and stray leading/trailing slashes before it reaches any vault API.
    const todoFile = normalizePath(this.plugin.settings.todoFile);
    const tagSuffix = subject ? ` #${subject}` : "";
    const newLine = `- [ ] ${text}${tagSuffix} 📅 ${this.date}`;
    const abstractFile = this.app.vault.getAbstractFileByPath(todoFile);

    if (abstractFile instanceof TFile) {
      const content = await this.app.vault.read(abstractFile);
      const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      await this.app.vault.modify(abstractFile, content + sep + newLine + "\n");
    } else {
      // Create the file (and any missing parent folders)
      const parts = todoFile.split("/");
      if (parts.length > 1) {
        const folderPath = parts.slice(0, -1).join("/");
        if (!this.app.vault.getAbstractFileByPath(folderPath)) {
          await this.app.vault.createFolder(folderPath);
        }
      }
      await this.app.vault.create(todoFile, newLine + "\n");
    }

    new Notice(`Added to ${todoFile}`);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class CalendarSettingTab extends PluginSettingTab {
  plugin: CalendarDeadlinesPlugin;
  private renderToken = 0;

  constructor(app: App, plugin: CalendarDeadlinesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display() {
    // display() awaits collectTasks() mid-render; if it's re-entered before
    // that resolves (e.g. the tab is closed/reopened quickly), the stale
    // call must not keep mutating containerEl after the newer one has.
    const token = ++this.renderToken;
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Calendar & Deadlines" });

    containerEl.createEl("h3", { text: "General" });

    new Setting(containerEl)
      .setName("Open sidebar on startup")
      .setDesc("Automatically opens the calendar sidebar when Obsidian starts.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.autoOpenSidebar)
          .onChange(async (value) => {
            this.plugin.settings.autoOpenSidebar = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Quick add" });

    new Setting(containerEl)
      .setName("TODO file")
      .setDesc("File where tasks are appended when you click a date on the calendar. Created automatically if it does not exist.")
      .addText(text =>
        text
          .setPlaceholder("TODO.md")
          .setValue(this.plugin.settings.todoFile)
          .onChange(async (value) => {
            this.plugin.settings.todoFile = normalizePath(value.trim() || "TODO.md");
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Reminders" });
    containerEl.createEl("p", {
      text: "Choose when to receive deadline reminders. Notifications appear as Obsidian toasts while the app is open.",
      cls: "cdp-setting-desc",
    });

    for (const option of OFFSET_OPTIONS) {
      new Setting(containerEl)
        .setName(option.label)
        .setDesc(option.desc)
        .addToggle(toggle =>
          toggle
            .setValue(this.plugin.settings.offsets.includes(option.days))
            .onChange(async (value) => {
              if (value) {
                this.plugin.settings.offsets.push(option.days);
              } else {
                this.plugin.settings.offsets =
                  this.plugin.settings.offsets.filter(d => d !== option.days);
              }
              await this.plugin.saveSettings();
            })
        );
    }

    containerEl.createEl("h3", { text: "Subject colors" });
    containerEl.createEl("p", {
      text: "Each subject tag (e.g. #MAT1100) gets a color automatically. Change any of them below — your choice is remembered.",
      cls: "cdp-setting-desc",
    });

    const tasks = await collectTasks(this.app);
    if (token !== this.renderToken) return; // superseded by a newer display() call

    const subjects = [...new Set(tasks.flatMap(t => t.subjects))].sort((a, b) =>
      a.localeCompare(b)
    );

    if (subjects.length === 0) {
      containerEl.createEl("p", {
        text: "No subject tags found yet. Add #SubjectName to a task to see it here.",
        cls: "cdp-setting-desc",
      });
      return;
    }

    let assignedNewColor = false;
    for (const subject of subjects) {
      const isNew = !(subject in this.plugin.settings.subjectColors);
      const color = getSubjectColor(this.plugin.settings, subject);
      if (isNew) assignedNewColor = true;

      new Setting(containerEl)
        .setName(subject)
        .addColorPicker(picker =>
          picker.setValue(color).onChange(async (value) => {
            this.plugin.settings.subjectColors[subject] = value;
            await this.plugin.saveSettings();
          })
        );
    }

    if (assignedNewColor) {
      await this.plugin.saveSettings();
    }
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class CalendarDeadlinesPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private notified = new Set<string>();
  private snoozedUntil: Record<string, number> = {};
  private notifyInterval: ReturnType<typeof setInterval> | null = null;
  private badgeEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new CalendarView(leaf, this));

    const ribbonEl = this.addRibbonIcon("calendar-days", "Calendar & Deadlines", () => {
      this.activateSidebarView();
    });
    ribbonEl.style.position = "relative";
    this.badgeEl = ribbonEl.createSpan({ cls: "cdp-badge cdp-badge-hidden" });

    this.addCommand({
      id: "open-calendar-sidebar",
      name: "Open sidebar",
      callback: () => this.activateSidebarView(),
    });

    this.addCommand({
      id: "open-calendar-modal",
      name: "Open as modal",
      callback: async () => {
        const tasks = await collectTasks(this.app);
        await this.ensureSubjectColors(tasks);
        new CalendarModal(this.app, this, tasks).open();
      },
    });

    this.addCommand({
      id: "create-task",
      name: "Create task",
      callback: () => new AddTaskModal(this.app, this).open(),
    });

    this.addSettingTab(new CalendarSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.autoOpenSidebar) {
        await this.activateSidebarView();
      }
      await this.checkNotifications();
      await this.updateBadge();
    });

    this.notifyInterval = setInterval(async () => {
      await this.checkNotifications();
      await this.updateBadge();
    }, 60_000);
  }

  async onunload() {
    if (this.notifyInterval) {
      clearInterval(this.notifyInterval);
      this.notifyInterval = null;
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async loadSettings() {
    const data: Partial<SavedData> = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
    this.settings.subjectColors = { ...data.settings?.subjectColors };
    this.settings.activeSubjectFilter = [...(data.settings?.activeSubjectFilter ?? [])];
    this.notified    = new Set(data.notified ?? []);
    this.snoozedUntil = data.snoozedUntil ?? {};
  }

  async saveSettings() {
    await this.saveData({
      settings:     this.settings,
      notified:     [...this.notified],
      snoozedUntil: this.snoozedUntil,
    } satisfies SavedData);
  }

  // Auto-assigns a color (via getSubjectColor) to any subject seen in `tasks`
  // that doesn't have one yet, and persists if anything new was assigned.
  async ensureSubjectColors(tasks: DeadlineTask[]) {
    const subjects = new Set(tasks.flatMap(t => t.subjects));
    let changed = false;
    for (const subject of subjects) {
      const isNew = !(subject in this.settings.subjectColors);
      getSubjectColor(this.settings, subject);
      if (isNew) changed = true;
    }
    if (changed) await this.saveSettings();
  }

  // Deliberately ignores activeSubjectFilter: the badge sits on the ribbon
  // icon, outside the sidebar/modal, so it always reflects the total across
  // all subjects. The in-panel stats bar is the one that respects the filter
  // (see renderCalendar()), and calls it out explicitly when active.
  private async updateBadge() {
    if (!this.badgeEl) return;
    const tasks = await collectTasks(this.app);
    const todayMs = new Date(
      new Date().getFullYear(), new Date().getMonth(), new Date().getDate()
    ).getTime();
    const count = tasks.filter(
      t => new Date(t.due + "T00:00:00").getTime() < todayMs
    ).length;

    if (count > 0) {
      this.badgeEl.setText(count > 99 ? "99+" : String(count));
      this.badgeEl.removeClass("cdp-badge-hidden");
    } else {
      this.badgeEl.addClass("cdp-badge-hidden");
    }
  }

  private async checkNotifications() {
    if (this.settings.offsets.length === 0) return;

    const tasks = await collectTasks(this.app);
    const todayMs = new Date(
      new Date().getFullYear(), new Date().getMonth(), new Date().getDate()
    ).getTime();
    let changed = false;

    for (const task of tasks) {
      const dueMs   = new Date(task.due + "T00:00:00").getTime();
      const diffDays = Math.ceil((dueMs - todayMs) / 86400000);

      if (diffDays < 0) continue;

      for (const offset of this.settings.offsets) {
        if (diffDays > offset) continue;

        const key = `${task.due}::${task.text}::${offset}`;

        // Respect snooze
        const snoozeUntil = this.snoozedUntil[key];
        if (snoozeUntil && Date.now() < snoozeUntil) continue;
        delete this.snoozedUntil[key];

        if (this.notified.has(key)) continue;

        this.notified.add(key);
        changed = true;

        this.showNotification(task, key, diffDays);
      }
    }

    // Prune entries older than 30 days
    for (const key of this.notified) {
      const datePart = key.split("::")[0];
      if ((todayMs - new Date(datePart + "T00:00:00").getTime()) > 30 * 86400000) {
        this.notified.delete(key);
        changed = true;
      }
    }

    if (changed) await this.saveSettings();
  }

  private showNotification(task: DeadlineTask, key: string, diffDays: number) {
    let timeLabel: string;
    if (diffDays === 0)      timeLabel = "due today";
    else if (diffDays === 1) timeLabel = "due tomorrow";
    else                     timeLabel = `due in ${diffDays} days`;

    const frag = document.createDocumentFragment();

    const msgEl = frag.createDiv({ cls: "cdp-notice-msg" });
    msgEl.createSpan({ text: "🗓 ", cls: "cdp-notice-icon" });
    msgEl.createSpan({ text: `${task.text} `, cls: "cdp-notice-task" });
    msgEl.createSpan({ text: `(${timeLabel})`, cls: "cdp-notice-time" });

    const actions = frag.createDiv({ cls: "cdp-notice-actions" });

    const snooze1h = actions.createEl("button", {
      text: "Snooze 1h",
      cls: "cdp-snooze-btn",
    });
    const snooze1d = actions.createEl("button", {
      text: "Tomorrow",
      cls: "cdp-snooze-btn",
    });
    const openBtn = actions.createEl("button", {
      text: "Open",
      cls: "cdp-snooze-btn cdp-snooze-btn--primary",
    });

    const notice = new Notice(frag, 10000);

    snooze1h.addEventListener("click", async () => {
      this.notified.delete(key);
      this.snoozedUntil[key] = Date.now() + 60 * 60 * 1000;
      await this.saveSettings();
      notice.hide();
    });

    snooze1d.addEventListener("click", async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      this.notified.delete(key);
      this.snoozedUntil[key] = tomorrow.getTime();
      await this.saveSettings();
      notice.hide();
    });

    openBtn.addEventListener("click", () => {
      openTask(this.app, task);
      notice.hide();
    });
  }

  private async activateSidebarView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }
}
