import {
  App,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
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
  filePath: string;
  line: number;
}

interface PluginSettings {
  offsets: number[]; // days before due date to notify
  todoFile: string;  // file to append quick-add tasks to
}

interface SavedData {
  settings: PluginSettings;
  notified: string[];
  snoozedUntil: Record<string, number>; // key → timestamp ms
}

const DEFAULT_SETTINGS: PluginSettings = {
  offsets: [0, 1],
  todoFile: "TODO.md",
};

const OFFSET_OPTIONS: { days: number; label: string; desc: string }[] = [
  { days: 0, label: "On the due date",  desc: "Notify on the day the task is due" },
  { days: 1, label: "1 day before",     desc: "Notify the day before" },
  { days: 3, label: "3 days before",    desc: "Notify 3 days in advance" },
  { days: 7, label: "1 week before",    desc: "Notify 7 days in advance" },
];

// ─── Task extraction ──────────────────────────────────────────────────────────

const DUE_RE =
  /📅\s*(\d{4}-\d{2}-\d{2})|due::\s*(\d{4}-\d{2}-\d{2})|⏳\s*(\d{4}-\d{2}-\d{2})/;

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
      const line = lines[i];
      if (!/^[\s]*-\s+\[[ ]\]/.test(line)) continue;
      const match = line.match(DUE_RE);
      if (!match) continue;
      const due = match[1] ?? match[2] ?? match[3];
      const text = line
        .replace(/^[\s]*-\s+\[[ ]\]\s*/, "")
        .replace(DUE_RE, "")
        .replace(/[⏫🔼🔽⏬📅⏳🛫✅❌]/g, "")
        .trim();
      tasks.push({ text, due, filePath: file.path, line: i });
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

// ─── Calendar renderer ────────────────────────────────────────────────────────

function renderCalendar(
  container: HTMLElement,
  tasks: DeadlineTask[],
  currentMonth: number,
  currentYear: number,
  onNav: (month: number, year: number) => void,
  onTaskClick: (task: DeadlineTask) => void,
  onDateClick?: (dateStr: string) => void
) {
  container.empty();

  const today = new Date();
  const todayMs = new Date(
    today.getFullYear(), today.getMonth(), today.getDate()
  ).getTime();

  const deadlineDates = new Map<string, string[]>();
  for (const t of tasks) {
    if (!deadlineDates.has(t.due)) deadlineDates.set(t.due, []);
    deadlineDates.get(t.due)!.push(t.text);
  }

  // ── Stats bar ──────────────────────────────────────────────────────────────
  const overdueCount  = tasks.filter(t => new Date(t.due + "T00:00:00").getTime() < todayMs).length;
  const todayCount    = tasks.filter(t => new Date(t.due + "T00:00:00").getTime() === todayMs).length;
  const weekCount     = tasks.filter(t => {
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
      cell.setAttribute("aria-label", deadlineDates.get(dateStr)!.join(", "));
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
  section.createEl("h4", { text: "Upcoming deadlines", cls: "cdp-section-title" });

  const upcoming = tasks.slice(0, 10);
  if (upcoming.length === 0) {
    section.createDiv({ text: "No upcoming deadlines", cls: "cdp-empty" });
    return;
  }

  for (const item of upcoming) {
    const row = section.createDiv({ cls: "cdp-item cdp-item-clickable" });
    row.setAttribute("title", `Open in ${item.filePath}`);
    row.addEventListener("click", () => onTaskClick(item));

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
    renderCalendar(
      content,
      this.tasks,
      this.month,
      this.year,
      (m, y) => { this.month = m; this.year = y; this.redraw(); },
      (task) => openTask(this.app, task),
      (dateStr) => new AddTaskModal(this.app, this.plugin.settings.todoFile, dateStr).open()
    );
  }

  async refresh() {
    this.tasks = await collectTasks(this.app);
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
  private todoFile: string;
  private tasks: DeadlineTask[];
  private month: number;
  private year: number;

  constructor(app: App, tasks: DeadlineTask[], todoFile: string) {
    super(app);
    this.todoFile = todoFile;
    this.tasks = tasks;
    const now = new Date();
    this.month = now.getMonth();
    this.year = now.getFullYear();
  }

  onOpen() {
    this.titleEl.setText("Calendar & Deadlines");
    this.redraw();
  }

  private redraw() {
    renderCalendar(
      this.contentEl,
      this.tasks,
      this.month,
      this.year,
      (m, y) => { this.month = m; this.year = y; this.redraw(); },
      (task) => { this.close(); openTask(this.app, task); },
      (dateStr) => { this.close(); new AddTaskModal(this.app, this.todoFile, dateStr).open(); }
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Add Task Modal ───────────────────────────────────────────────────────────

class AddTaskModal extends Modal {
  private todoFile: string;
  private date: string;

  constructor(app: App, todoFile: string, date: string) {
    super(app);
    this.todoFile = todoFile;
    this.date = date;
  }

  onOpen() {
    const { contentEl } = this;
    const [y, m, d] = this.date.split("-").map(Number);
    const MONTHS = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December",
    ];
    this.titleEl.setText(`Add task — ${MONTHS[m - 1]} ${d}, ${y}`);

    let taskText = "";

    const addTask = async () => {
      const trimmed = taskText.trim();
      if (!trimmed) return;
      await this.appendTask(trimmed);
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

    new Setting(contentEl)
      .addButton(btn =>
        btn.setButtonText("Add task")
          .setCta()
          .onClick(() => void addTask())
      );
  }

  private async appendTask(text: string) {
    const newLine = `- [ ] ${text} 📅 ${this.date}`;
    const abstractFile = this.app.vault.getAbstractFileByPath(this.todoFile);

    if (abstractFile instanceof TFile) {
      const content = await this.app.vault.read(abstractFile);
      const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      await this.app.vault.modify(abstractFile, content + sep + newLine + "\n");
    } else {
      // Create the file (and any missing parent folders)
      const parts = this.todoFile.split("/");
      if (parts.length > 1) {
        const folderPath = parts.slice(0, -1).join("/");
        if (!this.app.vault.getAbstractFileByPath(folderPath)) {
          await this.app.vault.createFolder(folderPath);
        }
      }
      await this.app.vault.create(this.todoFile, newLine + "\n");
    }

    new Notice(`Added to ${this.todoFile}`);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class CalendarSettingTab extends PluginSettingTab {
  plugin: CalendarDeadlinesPlugin;

  constructor(app: App, plugin: CalendarDeadlinesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Calendar & Deadlines" });

    containerEl.createEl("h3", { text: "Quick add" });

    new Setting(containerEl)
      .setName("TODO file")
      .setDesc("File where tasks are appended when you click a date on the calendar. Created automatically if it does not exist.")
      .addText(text =>
        text
          .setPlaceholder("TODO.md")
          .setValue(this.plugin.settings.todoFile)
          .onChange(async (value) => {
            this.plugin.settings.todoFile = value.trim() || "TODO.md";
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
        new CalendarModal(this.app, tasks, this.settings.todoFile).open();
      },
    });

    this.addSettingTab(new CalendarSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
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
    this.settings    = Object.assign({}, DEFAULT_SETTINGS, data.settings);
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
