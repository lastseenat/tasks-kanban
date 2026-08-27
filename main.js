const {
  ItemView,
  Menu,
  Modal,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} = require("obsidian");

const VIEW_TYPE = "tasks-kanban";
const BOARD_SELECTOR = ".tasks-kanban-board";
const LANE_SELECTOR = ".tasks-kanban-lane";
const CARD_SELECTOR = ".tasks-kanban-card";
const DEFAULT_LANE = "À faire";
const SUBLIST_FOLDER = "Sous-listes";
const BOARD_MARKER = /^kanban-plugin:\s*(?:board|basic)\s*$/im;
const STANDALONE_MARKER = /^tasks-kanban:\s*board\s*$/im;
const SETTINGS_MARKER = /^%%\s*kanban:settings\s*$/m;
const HEADING_PATTERN = /^##\s+(.+?)\s*$/;
const CARD_PATTERN = /^(\s*)-\s+\[([^\]])\]\s+(.*)$/;
const DURATION_PATTERN = /\s*(?:—|–|-)\s*(\d{1,3}):([0-5]\d)(?::([0-5]\d))?\s*$/;
const WIKI_LINK_PATTERN = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DONE_LANES = new Set(["terminé", "terminées", "fait", "faits", "done", "archive"]);

function canonical(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function timerStableText(value) {
  return String(value || "")
    .replace(WIKI_LINK_PATTERN, (_link, target, alias) => {
      const label = String(alias || "").trim();
      if (label) return label;
      return String(target || "").replace(/\\/g, "/").split("/").pop();
    })
    .replace(/^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D)+\s*/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function durationFromBody(body) {
  const match = String(body || "").match(DURATION_PATTERN);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  const milliseconds = ((hours * 60 + minutes) * 60 + seconds) * 1000;
  if (!Number.isFinite(milliseconds)) return null;

  return { milliseconds, match };
}

function parseCardLine(line, lineIndex = -1) {
  const match = String(line || "").match(CARD_PATTERN);
  if (!match) return null;

  const duration = durationFromBody(match[3]);
  const body = match[3];
  const title = duration ? body.slice(0, duration.match.index).trim() : body.trim();
  return {
    lineIndex,
    rawLine: line,
    prefix: `${match[1]}- [${match[2]}] `,
    marker: match[2],
    checked: /x/i.test(match[2]),
    rawBody: body,
    title,
    durationMs: duration?.milliseconds ?? null,
    durationToken: duration?.match[0]?.trim() || "",
    stableTitle: canonical(title.replace(WIKI_LINK_PATTERN, "$2")),
    stableText: timerStableText(title),
  };
}

class TaskKanbanView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.filePath = "";
    this.file = null;
    this.rendering = false;
    this.renderQueued = false;
    this.renderTarget = null;
    this.sortAction = null;
    this.visibilityAction = null;
    this.timerControls = new Map();
    this.laneTotals = new Map();
    this.summaryValues = new Map();
    this.remainingTimes = { todoMs: 0, laterMs: 0, totalMs: 0 };
    this.sleepControls = null;
    this.sections = [];
    this.identities = new Map();
    this.dragState = null;
    this.dropTarget = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    if (!this.filePath) return "Tâches Kanban";
    return this.filePath.split("/").pop().replace(/\.md$/i, "");
  }

  getIcon() {
    return "layout-dashboard";
  }

  getState() {
    return { file: this.filePath, filePath: this.filePath };
  }

  async setState(state, _result) {
    this.filePath = normalizePath(state?.filePath || state?.path || state?.file || "");
    this.file = this.plugin.getMarkdownFile(this.filePath);
    await this.render();
  }

  async onOpen() {
    this.contentEl.addClass("tasks-kanban-view");
    this.visibilityAction = this.addAction(
      "eye-off",
      "Afficher les colonnes secondaires",
      () => void this.toggleSecondaryLanes()
    );
    this.addAction("plus", "Ajouter une carte", () => void this.openAddCard());
    this.addAction("refresh-cw", "Actualiser le tableau", () => void this.render());
    await this.render();
  }

  async onClose() {
    this.dragState = null;
    this.clearDropIndicator();
    this.plugin.views.delete(this);
    this.renderQueued = false;
    this.renderTarget = null;
    this.timerControls.clear();
    this.laneTotals.clear();
    this.summaryValues.clear();
    this.remainingTimes = { todoMs: 0, laterMs: 0, totalMs: 0 };
    this.sleepControls = null;
    this.contentEl.empty();
  }

  async render() {
    if (this.rendering) {
      this.renderQueued = true;
      return;
    }
    this.rendering = true;
    const renderPath = this.filePath;
    const renderTarget = this.contentEl.createDiv({ cls: "tasks-kanban-render-target" });
    renderTarget.style.display = "none";
    this.renderTarget = renderTarget;
    this.contentEl.addClass("is-rendering");

    try {
      const file = this.plugin.getMarkdownFile(renderPath);
      if (!file) {
        renderTarget.createEl("p", {
          text: "La note Kanban n’est plus disponible.",
          cls: "tasks-kanban-message is-error",
        });
        this.updateActions([]);
        this.commitRender(renderTarget);
        return;
      }

      const content = await this.plugin.readFile(file);
      if (renderPath !== this.filePath) return;

      this.timerControls.clear();
      this.laneTotals.clear();
      this.summaryValues.clear();
      this.remainingTimes = { todoMs: 0, laterMs: 0, totalMs: 0 };
      this.sleepControls = null;
      this.identities.clear();
      const sections = this.plugin.parseBoard(content);
      this.sections = sections;
      this.plugin.boardTasks.set(renderPath, this.plugin.parseBoardTasks(content, renderPath));
      const occurrences = new Map();
      for (const section of sections) {
        for (const card of section.cards) {
          this.identities.set(
            card.lineIndex,
            this.plugin.getCardIdentity(renderPath, card, occurrences)
          );
        }
      }
      this.updateActions(sections);

      const boardHeader = renderTarget.createDiv({ cls: "tasks-kanban-board-header" });
      const heading = boardHeader.createDiv({ cls: "tasks-kanban-board-heading" });
      heading.createEl("h2", { text: this.getDisplayText() });
      heading.createEl("span", {
        text: renderPath,
        cls: "tasks-kanban-board-path",
      });
      const stats = boardHeader.createDiv({ cls: "tasks-kanban-board-stats" });
      const cardCount = sections.reduce((sum, section) => sum + section.cards.length, 0);
      stats.setText(`${sections.length} colonne${sections.length > 1 ? "s" : ""} · ${cardCount} carte${cardCount > 1 ? "s" : ""}`);
      const boardActions = boardHeader.createDiv({ cls: "tasks-kanban-board-actions" });
      const addBoard = boardActions.createEl("button", {
        cls: "tasks-kanban-icon-button clickable-icon",
        attr: {
          type: "button",
          "aria-label": "Créer un nouveau tableau",
          title: "Créer un nouveau tableau",
        },
      });
      setIcon(addBoard, "plus");
      addBoard.addEventListener("click", (event) => {
        event.stopPropagation();
        new AddBoardModal(this.app, this.plugin, { sourceView: this }).open();
      });
      const sortOrder = this.plugin.data.sortOrders[renderPath] || "none";
      const sortBoard = boardActions.createEl("button", {
        cls: "tasks-kanban-board-sort clickable-icon",
        attr: {
          type: "button",
          "aria-label": "Choisir le tri de ce tableau",
          title: sortOrder === "asc"
            ? "Ce tableau est trié par durée croissante"
            : sortOrder === "desc"
              ? "Ce tableau est trié par durée décroissante"
              : "Choisir le tri de ce tableau",
        },
      });
      setIcon(sortBoard, sortOrder === "asc" ? "sort-asc" : sortOrder === "desc" ? "sort-desc" : "arrow-down-up");
      sortBoard.appendText(
        sortOrder === "asc" ? "Trier : durée ↑" : sortOrder === "desc" ? "Trier : durée ↓" : "Trier ce tableau"
      );
      sortBoard.addEventListener("click", (event) => {
        event.stopPropagation();
        const menu = new Menu();
        menu.addItem((item) =>
          item
            .setTitle("Durée croissante")
            .setIcon("sort-asc")
            .setChecked(sortOrder === "asc")
            .onClick(() => void this.setSortOrder("asc"))
        );
        menu.addItem((item) =>
          item
            .setTitle("Durée décroissante")
            .setIcon("sort-desc")
            .setChecked(sortOrder === "desc")
            .onClick(() => void this.setSortOrder("desc"))
        );
        menu.showAtMouseEvent(event);
      });
      const moveBoard = boardActions.createEl("button", {
        cls: "tasks-kanban-icon-button clickable-icon",
        attr: {
          type: "button",
          "aria-label": "Déplacer ce tableau vers un dossier",
          title: "Déplacer ce tableau vers un dossier",
        },
      });
      setIcon(moveBoard, "folder-input");
      moveBoard.addEventListener("click", (event) => {
        event.stopPropagation();
        new MoveBoardModal(this.app, this.plugin, { sourceView: this }).open();
      });
      this.renderSleepControls(renderTarget);

      if (sections.length === 0) {
        renderTarget.createEl("p", {
          text: "Aucune colonne trouvée. Ajoutez un titre de niveau 2 (## À faire) à cette note.",
          cls: "tasks-kanban-message",
        });
        this.commitRender(renderTarget);
        return;
      }

      const board = renderTarget.createDiv({ cls: "tasks-kanban-board" });
      board.dataset.path = renderPath;

      sections.forEach((section, sectionIndex) => {
        this.renderLane(board, section, sectionIndex, sections.length, this.identities);
      });
      this.updateTotals();
      this.commitRender(renderTarget);
    } catch (error) {
      console.error("Tâches Kanban: impossible d'afficher la note", error);
      if (renderPath !== this.filePath) return;
      renderTarget.empty();
      renderTarget.createEl("p", {
        text: `Impossible d’afficher cette note : ${error.message || error}`,
        cls: "tasks-kanban-message is-error",
      });
      this.commitRender(renderTarget);
    } finally {
      if (renderTarget.isConnected) renderTarget.remove();
      if (this.renderTarget === renderTarget) this.renderTarget = null;
      this.rendering = false;
      this.contentEl.removeClass("is-rendering");
      if (this.renderQueued) {
        this.renderQueued = false;
        void this.render();
      }
    }
  }

  commitRender(renderTarget) {
    if (!renderTarget || renderTarget.parentElement !== this.contentEl) return;
    const children = Array.from(renderTarget.childNodes);
    this.contentEl.empty();
    this.contentEl.append(...children);
  }

  renderLane(board, section, sectionIndex, sectionCount, identities) {
    const hidden = this.plugin.isLaneHidden(this.filePath, section);
    const lane = board.createDiv({ cls: "tasks-kanban-lane" });
    lane.dataset.laneKey = section.key;
    lane.classList.toggle("is-hidden", hidden);
    lane.classList.toggle("is-empty", section.cards.length === 0);

    const header = lane.createDiv({ cls: "tasks-kanban-lane-header" });
    const title = header.createDiv({ cls: "tasks-kanban-lane-title" });
    title.createEl("h3", { text: section.title, attr: { title: section.title } });
    const meta = title.createDiv({ cls: "tasks-kanban-lane-meta" });
    meta.createEl("span", {
      text: String(section.cards.length),
      cls: "tasks-kanban-lane-count",
    });
    const laneTotal = meta.createEl("span", {
      text: "",
      cls: "tasks-kanban-lane-total",
    });
    this.laneTotals.set(section.key, laneTotal);

    const actions = header.createDiv({ cls: "tasks-kanban-lane-actions" });
    const addCard = actions.createEl("button", {
      cls: "tasks-kanban-icon-button clickable-icon tasks-kanban-lane-add",
      attr: {
        type: "button",
        "aria-label": `Ajouter une carte dans « ${section.title} »`,
        title: `Ajouter une carte dans « ${section.title} »`,
      },
    });
    setIcon(addCard, "plus");
    addCard.addEventListener("click", (event) => {
      event.stopPropagation();
      new AddCardModal(this.app, this.plugin, {
        sourceView: this,
        sections: this.sections,
        defaultLane: section.title,
      }).open();
    });
    const eye = actions.createEl("button", {
      cls: "tasks-kanban-icon-button clickable-icon tasks-kanban-lane-toggle",
      attr: {
        type: "button",
        "aria-label": hidden ? "Afficher cette colonne" : "Masquer cette colonne",
        title: hidden ? "Afficher cette colonne" : "Masquer cette colonne",
      },
    });
    setIcon(eye, hidden ? "eye" : "eye-off");
    eye.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.toggleLane(section);
    });

    const moveLane = actions.createEl("button", {
      cls: "tasks-kanban-icon-button clickable-icon tasks-kanban-lane-move",
      attr: {
        type: "button",
        "aria-label": "Déplacer cette colonne vers une autre note",
        title: "Déplacer cette colonne vers une autre note",
      },
    });
    setIcon(moveLane, "folder-input");
    moveLane.addEventListener("click", (event) => {
      event.stopPropagation();
      new MoveModal(this.app, this.plugin, {
        mode: "lane",
        sourceView: this,
        section,
      }).open();
    });

    const deleteLane = actions.createEl("button", {
      cls: "tasks-kanban-icon-button clickable-icon tasks-kanban-lane-delete",
      attr: {
        type: "button",
        "aria-label": `Supprimer la liste « ${section.title} »`,
        title: `Supprimer la liste « ${section.title} »`,
      },
    });
    setIcon(deleteLane, "trash-2");
    deleteLane.addEventListener("click", (event) => {
      event.stopPropagation();
      new DeleteLaneModal(this.app, this.plugin, {
        sourceView: this,
        section,
      }).open();
    });

    const cards = lane.createDiv({ cls: "tasks-kanban-lane-cards" });
    this.setupDropZone(cards, section);
    if (section.cards.length === 0) {
      cards.createEl("div", {
        text: "Aucune carte",
        cls: "tasks-kanban-empty-lane",
      });
    } else {
      section.cards.forEach((card) =>
        this.renderCard(cards, card, section, identities.get(card.lineIndex))
      );
    }

    if (sectionIndex === sectionCount - 1) {
      lane.addClass("is-last-lane");
    }
  }

  renderCard(container, card, section, identity) {
    const cardElement = container.createDiv({ cls: "tasks-kanban-card" });
    cardElement.classList.toggle("is-complete", card.checked);
    cardElement.dataset.lineIndex = String(card.lineIndex);
    cardElement.draggable = true;
    cardElement.addEventListener("dragstart", (event) => {
      const editingLabel = cardElement.classList.contains("is-label-editing") ||
        event.composedPath().some((element) =>
          element?.classList?.contains?.("tasks-kanban-card-label-input")
        );
      if (editingLabel) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.dragState = null;
        cardElement.classList.remove("is-dragging");
        return;
      }
      this.dragState = { card, section, element: cardElement };
      cardElement.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        try {
          event.dataTransfer.setData("text/plain", card.title);
        } catch (_error) {
          // Chromium can reject setData for synthetic drag events; native drag still works.
        }
      }
    });
    cardElement.addEventListener("dragend", () => {
      cardElement.classList.remove("is-dragging");
      this.dragState = null;
      this.clearDropIndicator();
    });

    const checkbox = cardElement.createEl("input", {
      cls: "tasks-kanban-card-checkbox",
      attr: { type: "checkbox", "aria-label": `Terminer ${card.title}` },
    });
    checkbox.checked = card.checked;
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      void this.plugin.updateCardCheck(this.filePath, card, checkbox.checked);
    });

    const body = cardElement.createDiv({ cls: "tasks-kanban-card-body" });
    this.renderInlineText(body, card.title);
    body.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.target?.closest?.("a")) return;
      event.stopPropagation();
      this.startCardLabelEdit(card, body, identity);
    });

    this.plugin.renderTimerControls(cardElement, {
      view: this,
      boardPath: this.filePath,
      section,
      card,
      identity,
    });

    const actions = cardElement.createDiv({ cls: "tasks-kanban-card-actions" });

    const menuButton = actions.createEl("button", {
      cls: "tasks-kanban-icon-button clickable-icon",
      attr: {
        type: "button",
        "aria-label": "Actions de la carte",
        title: "Actions de la carte",
      },
    });
    setIcon(menuButton, "ellipsis");
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Modifier le libellé")
          .setIcon("pencil")
          .onClick(() => this.startCardLabelEdit(card, body, identity))
      );
      menu.addItem((item) =>
        item
          .setTitle("Déplacer vers une autre note…")
          .setIcon("move-right")
          .onClick(() => {
            new MoveModal(this.app, this.plugin, {
              mode: "card",
              sourceView: this,
              card,
              section,
            }).open();
          })
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Supprimer la carte")
          .setIcon("trash-2")
          .onClick(() => void this.plugin.deleteCard(this.filePath, card, identity))
      );
      menu.showAtMouseEvent(event);
    });
  }

  startCardLabelEdit(card, body, identity) {
    if (!body?.isConnected || body.querySelector(".tasks-kanban-card-label-input")) return;
    const cardElement = body.closest(CARD_SELECTOR);
    const lockCardDrag = () => {
      if (!cardElement) return;
      cardElement.classList.add("is-label-editing");
      cardElement.draggable = false;
      cardElement.removeAttribute("draggable");
    };
    lockCardDrag();
    body.addClass("is-editing");
    body.empty();
    const input = body.createEl("input", {
      cls: "tasks-kanban-card-label-input",
      attr: {
        type: "text",
        "aria-label": "Modifier le libellé de la carte",
        autocomplete: "off",
      },
    });
    input.spellcheck = false;
    input.draggable = false;
    input.value = card.title;

    for (const eventName of ["click", "pointerdown", "mousedown", "touchstart"]) {
      input.addEventListener(eventName, (event) => {
        lockCardDrag();
        event.stopPropagation();
      });
    }
    input.addEventListener("selectstart", (event) => event.stopPropagation());
    input.addEventListener("dragstart", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    let finished = false;
    const restore = () => {
      if (!body.isConnected) return;
      if (cardElement?.isConnected) {
        cardElement.classList.remove("is-label-editing");
        cardElement.draggable = true;
      }
      body.empty();
      body.removeClass("is-editing");
      this.renderInlineText(body, card.title);
    };
    const cancel = () => {
      if (finished) return;
      finished = true;
      restore();
    };
    const commit = async () => {
      if (finished) return;
      const title = input.value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
      if (!title) {
        new Notice("Le libellé ne peut pas être vide.");
        input.focus();
        return;
      }
      finished = true;
      input.disabled = true;
      const updated = await this.plugin.updateCardLabel(this.filePath, card, identity, title);
      if (updated) {
        restore();
        return;
      }
      if (!body.isConnected) return;
      finished = false;
      input.disabled = false;
      input.focus();
      input.select();
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    });
    input.addEventListener("blur", () => void commit());
    input.focus();
    input.select();
  }

  setupDropZone(cards, section) {
    cards.addEventListener("dragover", (event) => {
      if (!this.dragState) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      this.updateDropIndicator(cards, this.getDropPlacement(event, cards));
    });
    cards.addEventListener("dragleave", (event) => {
      if (event.relatedTarget && cards.contains(event.relatedTarget)) return;
      if (this.dropTarget?.cards === cards) this.clearDropIndicator();
    });
    cards.addEventListener("drop", (event) => {
      event.preventDefault();
      if (!this.dragState) {
        this.clearDropIndicator();
        return;
      }

      const drag = this.dragState;
      const placement = this.getDropPlacement(event, cards);
      const targetCard = placement.element
        ? this.findCardByLineIndex(placement.element.dataset.lineIndex)
        : null;
      this.dragState = null;
      this.clearDropIndicator();
      if (placement.isSelf) return;
      if (targetCard?.lineIndex === drag.card.lineIndex) return;

      void this.plugin.moveCardWithinBoard(
        this.filePath,
        drag.card,
        section.key,
        targetCard,
        placement.before
      );
    });
  }

  getDropPlacement(event, cards) {
    const candidate = event.target?.closest?.(CARD_SELECTOR);
    const isSelf = candidate === this.dragState?.element;
    const element = candidate && cards.contains(candidate) && !isSelf
      ? candidate
      : null;
    if (!element) return { element: null, before: false, isSelf };
    const bounds = element.getBoundingClientRect();
    return {
      element,
      before: event.clientY < bounds.top + bounds.height / 2,
    };
  }

  updateDropIndicator(cards, placement) {
    this.clearDropIndicator();
    cards.classList.add("is-drag-over");
    if (placement.element) {
      placement.element.classList.add(placement.before ? "is-drop-before" : "is-drop-after");
    }
    this.dropTarget = {
      cards,
      element: placement.element,
    };
  }

  clearDropIndicator() {
    if (!this.dropTarget) return;
    this.dropTarget.cards?.classList.remove("is-drag-over");
    this.dropTarget.element?.classList.remove("is-drop-before", "is-drop-after");
    this.dropTarget = null;
  }

  findCardByLineIndex(lineIndex) {
    const numericLineIndex = Number(lineIndex);
    if (!Number.isInteger(numericLineIndex)) return null;
    for (const section of this.sections) {
      const card = section.cards.find((candidate) => candidate.lineIndex === numericLineIndex);
      if (card) return card;
    }
    return null;
  }

  renderSummary(sections) {
    const root = this.renderTarget || this.contentEl;
    const summary = root.createDiv({ cls: "tasks-kanban-summary" });
    summary.createEl("span", { text: "Restant", cls: "tasks-kanban-summary-label" });
    for (const [key, label] of [
      ["todo", "À faire"],
      ["later", "Plus tard"],
      ["total", "Total"],
    ]) {
      const item = summary.createDiv({ cls: "tasks-kanban-summary-item" });
      item.createEl("span", { text: label });
      const value = item.createEl("strong", { text: "—" });
      this.summaryValues.set(key, value);
    }
  }

  renderSleepControls(root) {
    const settings = this.plugin.getSleepSettings();
    const bar = root.createDiv({ cls: "tasks-kanban-sleep-bar" });

    const currentItem = bar.createDiv({ cls: "tasks-kanban-sleep-item" });
    currentItem.createEl("span", { text: "Heure actuelle" });
    const currentValue = currentItem.createEl("strong", { cls: "tasks-kanban-sleep-current" });

    const durationItem = bar.createDiv({ cls: "tasks-kanban-sleep-item" });
    durationItem.createEl("span", { text: "Sommeil prévu" });
    const durationInput = durationItem.createEl("input", {
      cls: "tasks-kanban-sleep-input",
      attr: {
        type: "text",
        inputmode: "numeric",
        autocomplete: "off",
        "aria-label": "Durée de sommeil prévue",
        title: "Format H:MM, par exemple 8:00",
      },
    });
    durationInput.value = this.plugin.formatSleepDuration(settings.durationMinutes);

    const wakeItem = bar.createDiv({ cls: "tasks-kanban-sleep-item" });
    wakeItem.createEl("span", { text: "Lever" });
    const wakeInput = wakeItem.createEl("input", {
      cls: "tasks-kanban-sleep-input",
      attr: {
        type: "text",
        inputmode: "numeric",
        autocomplete: "off",
        "aria-label": "Heure de lever",
        title: "Format HH:MM, par exemple 07:00",
      },
    });
    wakeInput.value = settings.wakeTime;

    const bedtimeItem = bar.createDiv({ cls: "tasks-kanban-sleep-item" });
    bedtimeItem.createEl("span", { text: "Coucher" });
    const bedtimeValue = bedtimeItem.createEl("strong", {
      cls: "tasks-kanban-sleep-time tasks-kanban-sleep-bedtime",
    });

    const todoFinishItem = bar.createDiv({ cls: "tasks-kanban-sleep-item" });
    todoFinishItem.createEl("span", { text: "À faire" });
    const todoFinishValue = todoFinishItem.createEl("strong", {
      cls: "tasks-kanban-sleep-time tasks-kanban-sleep-todo-finish",
    });

    const allFinishItem = bar.createDiv({ cls: "tasks-kanban-sleep-item" });
    allFinishItem.createEl("span", { text: "Avec plus tard" });
    const allFinishValue = allFinishItem.createEl("strong", {
      cls: "tasks-kanban-sleep-time tasks-kanban-sleep-all-finish",
    });

    this.sleepControls = {
      bar,
      currentValue,
      durationInput,
      wakeInput,
      bedtimeValue,
      todoFinishValue,
      allFinishValue,
      editingDuration: false,
      editingWake: false,
    };
    this.bindSleepInput(durationInput, "duration");
    this.bindSleepInput(wakeInput, "wake");
    this.updateSleepDisplay();
  }

  bindSleepInput(input, type) {
    const editingKey = type === "duration" ? "editingDuration" : "editingWake";
    input.addEventListener("focus", () => {
      if (!this.sleepControls) return;
      this.sleepControls[editingKey] = true;
      input.select();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (this.sleepControls) this.sleepControls[editingKey] = false;
        this.updateSleepDisplay();
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      if (!this.sleepControls || !this.sleepControls[editingKey]) return;
      this.sleepControls[editingKey] = false;
      if (type === "duration") this.commitSleepDuration(input);
      else this.commitSleepWake(input);
    });
  }

  commitSleepDuration(input) {
    const durationMinutes = this.plugin.parseSleepDuration(input.value);
    if (durationMinutes === null) {
      new Notice("Utilisez le format H:MM, par exemple 8:00.");
      this.updateSleepDisplay();
      return;
    }
    this.plugin.updateSleepSettings({ durationMinutes });
    this.updateSleepDisplay();
  }

  commitSleepWake(input) {
    const wakeTime = this.plugin.parseWakeTime(input.value);
    if (!wakeTime) {
      new Notice("Utilisez le format HH:MM, par exemple 07:00.");
      this.updateSleepDisplay();
      return;
    }
    this.plugin.updateSleepSettings({ wakeTime });
    this.updateSleepDisplay();
  }

  updateSleepDisplay() {
    const controls = this.sleepControls;
    if (!controls?.bar?.isConnected) return;
    const settings = this.plugin.getSleepSettings();
    const now = new Date();
    const bedtime = this.plugin.getSleepBedtimeDate(settings.durationMinutes, settings.wakeTime, now);
    const todoFinish = new Date(now.getTime() + Math.max(0, this.remainingTimes.todoMs || 0));
    const allFinish = new Date(now.getTime() + Math.max(0, this.remainingTimes.totalMs || 0));
    const status = allFinish <= bedtime
      ? "safe"
      : todoFinish <= bedtime
        ? "warning"
        : "danger";
    controls.currentValue.setText(this.plugin.formatClock(now));
    if (!controls.editingDuration) {
      controls.durationInput.value = this.plugin.formatSleepDuration(settings.durationMinutes);
    }
    if (!controls.editingWake) controls.wakeInput.value = settings.wakeTime;
    controls.bedtimeValue.setText(this.plugin.formatClock(bedtime));
    controls.todoFinishValue.setText(this.plugin.formatClock(todoFinish));
    controls.allFinishValue.setText(this.plugin.formatClock(allFinish));
    this.setSleepStatus(controls.bedtimeValue, status);
    this.setSleepStatus(controls.todoFinishValue, todoFinish <= bedtime ? "safe" : "danger");
    this.setSleepStatus(controls.allFinishValue, status);
  }

  setSleepStatus(element, status) {
    if (!element) return;
    element.classList.remove("is-safe", "is-warning", "is-danger");
    element.classList.add(`is-${status}`);
  }

  updateTotals() {
    let todoMs = 0;
    let laterMs = 0;
    for (const section of this.sections) {
      const totalMs = this.plugin.calculateSectionRemaining(
        this.filePath,
        section,
        this.identities,
        Date.now()
      );
      const laneTotal = this.laneTotals.get(section.key);
      if (laneTotal) laneTotal.setText(this.plugin.formatCompactDuration(totalMs));
      const laneKey = canonical(section.title);
      if (laneKey === canonical("à faire")) todoMs += totalMs;
      if (laneKey === canonical("plus tard")) laterMs += totalMs;
    }
    const totalMs = todoMs + laterMs;
    this.remainingTimes = { todoMs, laterMs, totalMs };
    const values = { todo: todoMs, later: laterMs, total: totalMs };
    for (const [key, value] of Object.entries(values)) {
      const element = this.summaryValues.get(key);
      if (element) element.setText(this.plugin.formatCompactDuration(value));
    }
    this.updateSleepDisplay();
  }

  updateTimerControls() {
    for (const control of this.timerControls.values()) {
      this.plugin.updateTimerControl(control);
    }
    this.updateTotals();
  }

  renderInlineText(container, text) {
    const value = String(text || "");
    WIKI_LINK_PATTERN.lastIndex = 0;
    let cursor = 0;
    let match;
    while ((match = WIKI_LINK_PATTERN.exec(value))) {
      if (match.index > cursor) {
        container.appendText(value.slice(cursor, match.index));
      }
      const target = match[1].trim();
      const label = (match[2] || target).trim();
      const link = container.createEl("a", {
        text: label,
        cls: "internal-link",
        attr: { href: target },
      });
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void this.app.workspace.openLinkText(
          target,
          this.filePath,
          Boolean(event.ctrlKey || event.metaKey)
        );
      });
      cursor = match.index + match[0].length;
    }
    if (cursor < value.length) container.appendText(value.slice(cursor));
  }

  updateActions(sections) {
    if (this.visibilityAction) {
      const secondary = sections.length > 1 ? sections.slice(1) : sections;
      const allHidden = secondary.length > 0 && secondary.every((section) =>
        this.plugin.isLaneHidden(this.filePath, section)
      );
      const icon = allHidden ? "eye" : "eye-off";
      const label = allHidden
        ? "Afficher les colonnes secondaires"
        : "Masquer les colonnes secondaires";
      if (this.visibilityAction.dataset.iconName !== icon) {
        this.visibilityAction.replaceChildren();
        setIcon(this.visibilityAction, icon);
        this.visibilityAction.dataset.iconName = icon;
      }
      this.visibilityAction.setAttribute("aria-label", label);
      this.visibilityAction.setAttribute("title", label);
    }
  }

  async cycleSort() {
    const current = this.plugin.data.sortOrders[this.filePath] || "none";
    const next = current === "asc" ? "desc" : "asc";
    await this.setSortOrder(next);
  }

  async setSortOrder(order) {
    if (!this.filePath || !["asc", "desc"].includes(order)) return;
    if (this.plugin.data.sortOrders[this.filePath] === order) return;
    this.plugin.data.sortOrders[this.filePath] = order;
    await this.plugin.saveStore();
    await this.plugin.sortBoard(this.filePath, order);
  }

  async toggleLane(section) {
    this.plugin.setLaneHidden(
      this.filePath,
      section,
      !this.plugin.isLaneHidden(this.filePath, section)
    );
    await this.plugin.saveStore();
    await this.render();
  }

  async toggleSecondaryLanes() {
    const file = this.plugin.getMarkdownFile(this.filePath);
    if (!file) return;
    const sections = this.plugin.parseBoard(await this.plugin.readFile(file));
    const secondary = sections.length > 1 ? sections.slice(1) : sections;
    if (secondary.length === 0) return;
    const allHidden = secondary.every((section) =>
      this.plugin.isLaneHidden(this.filePath, section)
    );
    for (const section of secondary) {
      this.plugin.setLaneHidden(this.filePath, section, !allHidden);
    }
    await this.plugin.saveStore();
    await this.render();
  }

  async openAddCard() {
    const file = this.plugin.getMarkdownFile(this.filePath);
    if (!file) return;
    const sections = this.plugin.parseBoard(await this.plugin.readFile(file));
    if (sections.length === 0) {
      new Notice("Ajoutez d’abord une colonne à cette note.");
      return;
    }
    new AddCardModal(this.app, this.plugin, {
      sourceView: this,
      sections,
      defaultLane: sections[0].title,
    }).open();
  }
}

class MoveModal extends Modal {
  constructor(app, plugin, details) {
    super(app);
    this.plugin = plugin;
    this.details = details;
    this.boards = [];
    this.boardSelect = null;
    this.laneSelect = null;
    this.confirmButton = null;
  }

  onOpen() {
    this.titleEl.setText(
      this.details.mode === "lane"
        ? "Déplacer une colonne"
        : "Déplacer une carte"
    );
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text:
        this.details.mode === "lane"
          ? `Déplacer « ${this.details.section.title} » vers une autre note.`
          : `Déplacer « ${this.details.card.title} » vers une autre note.`,
    });

    const boardLabel = contentEl.createEl("label", { text: "Note de destination" });
    this.boardSelect = contentEl.createEl("select");
    boardLabel.setAttribute("for", "tasks-kanban-target-board");
    this.boardSelect.id = "tasks-kanban-target-board";
    this.boardSelect.createEl("option", { text: "Chargement…", value: "" });

    const laneLabel = contentEl.createEl("label", { text: "Colonne de destination" });
    this.laneSelect = contentEl.createEl("select");
    laneLabel.setAttribute("for", "tasks-kanban-target-lane");
    this.laneSelect.id = "tasks-kanban-target-lane";
    this.laneSelect.createEl("option", { text: "Choisir d’abord une note…", value: "" });

    this.confirmButton = contentEl.createEl("button", {
      text: "Déplacer",
      cls: "mod-cta",
      attr: { disabled: "true" },
    });
    this.boardSelect.addEventListener("change", () => void this.updateLanes());
    this.laneSelect.addEventListener("change", () => this.updateButton());
    this.confirmButton.addEventListener("click", () => void this.confirm());
    void this.loadBoards();
  }

  async loadBoards() {
    this.boards = await this.plugin.getDestinationBoards(this.details.sourceView.filePath);
    this.boardSelect.replaceChildren();
    this.boardSelect.createEl("option", { text: "Choisir une note…", value: "" });
    for (const board of this.boards) {
      this.boardSelect.createEl("option", { text: board.path, value: board.path });
    }
    if (this.boards.length === 0) {
      this.boardSelect.createEl("option", { text: "Aucune note disponible", value: "" });
    }
    this.updateButton();
  }

  async updateLanes() {
    this.laneSelect.replaceChildren();
    this.laneSelect.createEl("option", { text: "Chargement…", value: "" });
    this.laneSelect.disabled = true;
    this.updateButton();

    const board = this.boards.find((candidate) => candidate.path === this.boardSelect.value);
    if (!board) return;
    const content = await this.plugin.readFile(board);
    const sections = this.plugin.parseBoard(content);
    const defaultLane = this.details.mode === "lane"
      ? this.details.section.title
      : DEFAULT_LANE;
    this.laneSelect.replaceChildren();
    this.laneSelect.createEl("option", { text: "Choisir une colonne…", value: "" });
    if (sections.length === 0 && content.trim() === "") {
      this.laneSelect.createEl("option", { text: `Créer « ${defaultLane} »`, value: defaultLane });
    } else {
      for (const section of sections) {
        this.laneSelect.createEl("option", { text: section.title, value: section.title });
      }
    }
    this.laneSelect.disabled = false;
    this.updateButton();
  }

  updateButton() {
    if (!this.confirmButton) return;
    this.confirmButton.disabled = !this.boardSelect?.value || !this.laneSelect?.value;
  }

  async confirm() {
    const targetPath = this.boardSelect.value;
    const targetLane = this.laneSelect.value;
    if (!targetPath || !targetLane) return;
    this.close();

    if (this.details.mode === "lane") {
      await this.plugin.moveLaneToBoard(
        this.details.sourceView.filePath,
        this.details.section,
        targetPath,
        targetLane
      );
    } else {
      await this.plugin.moveCardToBoard(
        this.details.sourceView.filePath,
        this.details.card,
        targetPath,
        targetLane
      );
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class DeleteLaneModal extends Modal {
  constructor(app, plugin, details) {
    super(app);
    this.plugin = plugin;
    this.details = details;
  }

  onOpen() {
    const { contentEl } = this;
    const section = this.details.section;
    const cardCount = section.cards.length;
    this.titleEl.setText("Supprimer la liste");
    contentEl.empty();
    contentEl.createEl("p", {
      text: `Supprimer « ${section.title} » et ses ${cardCount} carte${cardCount > 1 ? "s" : ""} ?`,
    });
    contentEl.createEl("p", {
      text: "Cette action retirera toute la liste de la note Markdown.",
      cls: "tasks-kanban-modal-help",
    });
    const actions = contentEl.createDiv({ cls: "tasks-kanban-confirm-actions" });
    const cancel = actions.createEl("button", { text: "Annuler" });
    const confirm = actions.createEl("button", {
      text: "Supprimer",
      cls: "mod-warning tasks-kanban-confirm-delete",
    });
    cancel.addEventListener("click", () => this.close());
    confirm.addEventListener("click", () => void this.confirm());
  }

  async confirm() {
    const { sourceView, section } = this.details;
    this.close();
    await this.plugin.deleteLane(sourceView.filePath, section);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class AddBoardModal extends Modal {
  constructor(app, plugin, details) {
    super(app);
    this.plugin = plugin;
    this.details = details;
    this.titleInput = null;
    this.folderInput = null;
  }

  onOpen() {
    const { contentEl } = this;
    const currentFile = this.plugin.getMarkdownFile(this.details.sourceView.filePath);
    this.titleEl.setText("Nouveau tableau");
    contentEl.empty();
    const titleLabel = contentEl.createEl("label", { text: "Nom du tableau" });
    this.titleInput = contentEl.createEl("input", {
      attr: {
        type: "text",
        placeholder: "Ex. Projets maison",
        autocomplete: "off",
      },
    });
    this.titleInput.id = "tasks-kanban-new-board-title";
    titleLabel.setAttribute("for", this.titleInput.id);

    const folderLabel = contentEl.createEl("label", { text: "Dossier" });
    this.folderInput = contentEl.createEl("input", {
      attr: {
        type: "text",
        list: "tasks-kanban-new-board-folders",
        placeholder: "Dossier ou laisser vide pour la racine",
        autocomplete: "off",
      },
    });
    this.folderInput.id = "tasks-kanban-new-board-folder";
    folderLabel.setAttribute("for", this.folderInput.id);
    this.folderInput.value = currentFile?.parent?.path || "";
    const folders = contentEl.createEl("datalist", { attr: { id: "tasks-kanban-new-board-folders" } });
    folders.createEl("option", { value: "", text: "Racine du coffre" });
    for (const folder of this.app.vault.getAllFolders().sort((a, b) => a.path.localeCompare(b.path, "fr"))) {
      folders.createEl("option", { value: folder.path });
    }
    contentEl.createEl("p", {
      text: "Le tableau est créé avec une colonne « À faire » vide et s’ouvrira ici.",
      cls: "tasks-kanban-modal-help",
    });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Annuler" });
    const create = buttons.createEl("button", { text: "Créer", cls: "mod-cta" });
    cancel.addEventListener("click", () => this.close());
    create.addEventListener("click", () => void this.confirm());
    this.titleInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void this.confirm();
    });
    this.titleInput.focus();
  }

  async confirm() {
    const created = await this.plugin.createBoard(
      this.titleInput?.value || "",
      this.folderInput?.value || ""
    );
    if (created) this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class MoveBoardModal extends Modal {
  constructor(app, plugin, details) {
    super(app);
    this.plugin = plugin;
    this.details = details;
    this.folderInput = null;
  }

  onOpen() {
    const { contentEl } = this;
    const file = this.plugin.getMarkdownFile(this.details.sourceView.filePath);
    this.titleEl.setText("Déplacer le tableau");
    contentEl.empty();
    const label = contentEl.createEl("label", { text: "Dossier de destination" });
    this.folderInput = contentEl.createEl("input", {
      attr: {
        type: "text",
        list: "tasks-kanban-board-folders",
        placeholder: "Dossier ou laisser vide pour la racine",
        autocomplete: "off",
      },
    });
    this.folderInput.id = "tasks-kanban-board-folder";
    label.setAttribute("for", this.folderInput.id);
    this.folderInput.value = file?.parent?.path || "";
    const folders = contentEl.createEl("datalist", { attr: { id: "tasks-kanban-board-folders" } });
    folders.createEl("option", { value: "", text: "Racine du coffre" });
    for (const folder of this.app.vault.getAllFolders().sort((a, b) => a.path.localeCompare(b.path, "fr"))) {
      folders.createEl("option", { value: folder.path });
    }
    contentEl.createEl("p", {
      text: "Les liens Obsidian vers ce tableau sont conservés et les minuteurs de ses cartes suivent le déplacement.",
      cls: "tasks-kanban-modal-help",
    });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Annuler" });
    const move = buttons.createEl("button", { text: "Déplacer", cls: "mod-cta" });
    cancel.addEventListener("click", () => this.close());
    move.addEventListener("click", () => void this.confirm());
    this.folderInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void this.confirm();
    });
    this.folderInput.focus();
    this.folderInput.select();
  }

  async confirm() {
    const moved = await this.plugin.moveBoard(this.details.sourceView.filePath, this.folderInput?.value || "");
    if (moved) this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class AddCardModal extends Modal {
  constructor(app, plugin, details) {
    super(app);
    this.plugin = plugin;
    this.details = details;
    this.titleInput = null;
    this.durationInput = null;
    this.laneSelect = null;
  }

  onOpen() {
    this.titleEl.setText("Ajouter une carte");
    const { contentEl } = this;
    contentEl.empty();

    const titleLabel = contentEl.createEl("label", { text: "Carte" });
    this.titleInput = contentEl.createEl("input", {
      attr: {
        type: "text",
        placeholder: "Ex. Appeler le médecin ou [[Note liée]]",
        autocomplete: "off",
      },
    });
    this.titleInput.id = "tasks-kanban-new-card-title";
    titleLabel.setAttribute("for", this.titleInput.id);

    const laneLabel = contentEl.createEl("label", { text: "Colonne" });
    this.laneSelect = contentEl.createEl("select");
    this.laneSelect.id = "tasks-kanban-new-card-lane";
    laneLabel.setAttribute("for", this.laneSelect.id);
    for (const section of this.details.sections || []) {
      this.laneSelect.createEl("option", {
        text: section.title,
        value: section.title,
      });
    }
    this.laneSelect.value = this.details.defaultLane || this.details.sections?.[0]?.title || "";

    const durationLabel = contentEl.createEl("label", { text: "Durée estimée" });
    this.durationInput = contentEl.createEl("input", {
      attr: {
        type: "text",
        value: "1:00",
        placeholder: "H:MM ou H:MM:SS",
        inputmode: "numeric",
      },
    });
    this.durationInput.id = "tasks-kanban-new-card-duration";
    durationLabel.setAttribute("for", this.durationInput.id);
    contentEl.createEl("p", {
      text: "Les liens [[…]] saisis ici resteront directement cliquables dans la carte.",
      cls: "tasks-kanban-modal-help",
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Annuler" });
    const add = buttons.createEl("button", { text: "Ajouter", cls: "mod-cta" });
    cancel.addEventListener("click", () => this.close());
    add.addEventListener("click", () => void this.confirm());
    this.titleInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.confirm();
      }
    });
    this.titleInput.focus();
  }

  async confirm() {
    const title = this.titleInput?.value || "";
    const lane = this.laneSelect?.value || "";
    const duration = this.durationInput?.value || "";
    if (!title.trim() || !lane) {
      new Notice("Indiquez un titre et une colonne.");
      return;
    }
    const added = await this.plugin.addCardToBoard(
      this.details.sourceView.filePath,
      lane,
      title,
      duration
    );
    if (added) this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = class TasksKanbanPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    const legacyStore = this.app.plugins?.getPlugin?.("kanban-task-timer")?.store || {};
    const savedSleep = saved.sleepSettings && typeof saved.sleepSettings === "object"
      ? saved.sleepSettings
      : {};
    const savedSleepDuration = Number(savedSleep.durationMinutes);
    const savedWakeTime = String(savedSleep.wakeTime || "");
    this.data = {
      version: 2,
      hiddenLanes: saved.hiddenLanes && typeof saved.hiddenLanes === "object" ? saved.hiddenLanes : {},
      sortOrders: saved.sortOrders && typeof saved.sortOrders === "object" ? saved.sortOrders : {},
      sleepSettings: {
        durationMinutes: Number.isFinite(savedSleepDuration)
          ? Math.min(24 * 60, Math.max(0, Math.round(savedSleepDuration)))
          : 8 * 60,
        wakeTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(savedWakeTime) ? savedWakeTime : "07:00",
      },
      timers: {
        ...(legacyStore.timers && typeof legacyStore.timers === "object" ? legacyStore.timers : {}),
        ...(saved.timers && typeof saved.timers === "object" ? saved.timers : {}),
      },
      forcedStarts: {
        ...(legacyStore.forcedStarts && typeof legacyStore.forcedStarts === "object" ? legacyStore.forcedStarts : {}),
        ...(saved.forcedStarts && typeof saved.forcedStarts === "object" ? saved.forcedStarts : {}),
      },
    };
    this.views = new Set();
    this.boardTasks = new Map();
    this.boardTaskLoads = new Map();
    this.sublistMarkers = new Map();
    this.fileProcessQueues = new Map();
    this.saveQueued = null;
    this.autoOpenToken = 0;

    this.registerView(VIEW_TYPE, (leaf) => {
      const view = new TaskKanbanView(leaf, this);
      this.views.add(view);
      return view;
    });
    this.registerLeafViewInterceptor();

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        void this.autoOpenBoardFile(file);
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        void this.autoOpenBoardFile(leaf?.view?.file);
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-ready", () => {
        void this.autoOpenActiveBoard();
      })
    );

    this.addCommand({
      id: "open-active-file",
      name: "Ouvrir la note active dans Tâches Kanban",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file instanceof TFile && file.extension === "md";
        if (!checking && available) void this.openBoard(file.path);
        return available;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Ouvrir dans Tâches Kanban")
            .setIcon("layout-dashboard")
            .onClick(() => void this.openBoard(file.path))
        );
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.boardTasks.delete(file.path);
        this.sublistMarkers.delete(file.path);
        for (const view of this.views) {
          if (view.filePath === file.path) void view.render();
          else view.updateTimerControls();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        for (const view of this.views) {
          if (view.filePath === oldPath) {
            view.filePath = file.path;
            void view.render();
          }
        }
      })
    );

    this.addRibbonIcon("layout-dashboard", "Ouvrir la note active dans Tâches Kanban", () => {
      const file = this.app.workspace.getActiveFile();
      if (file?.extension === "md") void this.openBoard(file.path);
      else new Notice("Sélectionnez une note Markdown.");
    });

    this.registerInterval(
      window.setInterval(() => {
        for (const view of this.views) view.updateTimerControls();
      }, 1000)
    );

    void this.autoOpenActiveBoard();
  }

  onunload() {
    if (this.saveQueued) window.clearTimeout(this.saveQueued);
    this.views.clear();
    void this.saveData(this.data);
  }

  async autoOpenActiveBoard() {
    await this.autoOpenBoardFile(this.app.workspace.getActiveFile());
  }

  registerLeafViewInterceptor() {
    const prototype = WorkspaceLeaf?.prototype;
    const original = prototype?.setViewState;
    if (typeof original !== "function") return;

    const plugin = this;
    const patched = function (viewState, ...args) {
      let nextState = viewState;
      const sourcePath = viewState?.state?.file;
      const sourceType = viewState?.type;
      if ((sourceType === "markdown" || sourceType === "kanban") && sourcePath) {
        const path = normalizePath(sourcePath);
        const frontmatter = plugin.app.metadataCache.getCache(path)?.frontmatter;
        const kanbanMarker = String(frontmatter?.["kanban-plugin"] || "").toLowerCase();
        const tasksMarker = String(frontmatter?.["tasks-kanban"] || "").toLowerCase();
        if (kanbanMarker === "board" || kanbanMarker === "basic" || tasksMarker === "board") {
          nextState = {
            ...viewState,
            type: VIEW_TYPE,
            state: {
              ...viewState.state,
              filePath: path,
            },
          };
        }
      }
      return original.call(this, nextState, ...args);
    };

    prototype.setViewState = patched;
    this.register(() => {
      if (prototype.setViewState === patched) prototype.setViewState = original;
    });
  }

  async autoOpenBoardFile(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const token = ++this.autoOpenToken;
    const content = await this.readFile(file);
    if (token !== this.autoOpenToken || !this.isBoardContent(content)) return;

    const activeLeaf = this.app.workspace.activeLeaf;
    const activeView = activeLeaf?.view;
    if (activeView?.getViewType?.() === VIEW_TYPE && activeView.filePath === file.path) return;

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.path !== file.path) return;
    await this.openBoard(file.path);
  }

  async openBoard(path) {
    const file = this.getMarkdownFile(path);
    if (!file) {
      new Notice("La note sélectionnée n’est pas disponible.");
      return;
    }
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existingLeaf?.view?.getViewType?.() === VIEW_TYPE) {
      if (existingLeaf.view.filePath !== file.path) {
        await existingLeaf.view.setState({ file: file.path, filePath: file.path });
      }
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE,
      state: { file: file.path, filePath: file.path },
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  getMarkdownFile(path) {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path || ""));
    return file instanceof TFile && file.extension === "md" ? file : null;
  }

  async readFile(file) {
    return this.app.vault.cachedRead(file);
  }

  async saveStore() {
    await this.saveData(this.data);
  }

  queueSave(immediate = false) {
    if (this.saveQueued) {
      window.clearTimeout(this.saveQueued);
      this.saveQueued = null;
    }
    if (immediate) {
      void this.saveStore();
      return;
    }
    this.saveQueued = window.setTimeout(() => {
      this.saveQueued = null;
      void this.saveStore();
    }, 300);
  }

  getSleepSettings() {
    if (!this.data.sleepSettings || typeof this.data.sleepSettings !== "object") {
      this.data.sleepSettings = { durationMinutes: 8 * 60, wakeTime: "07:00" };
    }
    const durationMinutes = Number(this.data.sleepSettings.durationMinutes);
    this.data.sleepSettings.durationMinutes = Number.isFinite(durationMinutes)
      ? Math.min(24 * 60, Math.max(0, Math.round(durationMinutes)))
      : 8 * 60;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(this.data.sleepSettings.wakeTime || ""))) {
      this.data.sleepSettings.wakeTime = "07:00";
    }
    return this.data.sleepSettings;
  }

  updateSleepSettings(values = {}) {
    const settings = this.getSleepSettings();
    if (Number.isFinite(Number(values.durationMinutes))) {
      settings.durationMinutes = Math.min(24 * 60, Math.max(0, Math.round(Number(values.durationMinutes))));
    }
    if (typeof values.wakeTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(values.wakeTime)) {
      settings.wakeTime = values.wakeTime;
    }
    this.queueSave(true);
  }

  formatClock(date = new Date()) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  formatSleepDuration(durationMinutes) {
    const totalMinutes = Math.max(0, Math.round(Number(durationMinutes) || 0));
    return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, "0")}`;
  }

  parseSleepDuration(value) {
    const match = String(value || "").trim().match(/^(\d{1,2}):([0-5]\d)$/);
    if (!match) return null;
    const durationMinutes = Number(match[1]) * 60 + Number(match[2]);
    return durationMinutes <= 24 * 60 ? durationMinutes : null;
  }

  parseWakeTime(value) {
    const match = String(value || "").trim().match(/^(0\d|1\d|2[0-3]):([0-5]\d)$/);
    return match ? `${match[1]}:${match[2]}` : null;
  }

  calculateBedtime(durationMinutes, wakeTime) {
    const normalizedWake = this.parseWakeTime(wakeTime);
    if (!normalizedWake) return "—";
    const [hours, minutes] = normalizedWake.split(":").map(Number);
    const total = (hours * 60 + minutes - Math.max(0, Number(durationMinutes) || 0) + 24 * 60) % (24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  getSleepBedtimeDate(durationMinutes, wakeTime, now = new Date()) {
    const normalizedWake = this.parseWakeTime(wakeTime);
    if (!normalizedWake) return new Date(now.getTime());
    const [hours, minutes] = normalizedWake.split(":").map(Number);
    const bedtime = new Date(now.getTime());
    bedtime.setHours(hours, minutes, 0, 0);
    if (bedtime <= now) bedtime.setDate(bedtime.getDate() + 1);
    bedtime.setMinutes(bedtime.getMinutes() - Math.max(0, Number(durationMinutes) || 0));
    return bedtime;
  }

  getCardIdentity(boardPath, card, occurrences = new Map()) {
    const stableText = card?.stableText || timerStableText(card?.title);
    const baseKey = `${boardPath}::${stableText}`;
    const occurrence = (occurrences.get(baseKey) || 0) + 1;
    occurrences.set(baseKey, occurrence);
    return {
      key: `${baseKey}::${occurrence}`,
      stableText,
      occurrence,
      durationMs: Number.isFinite(Number(card?.durationMs)) ? Number(card.durationMs) : 0,
      sublistPath: this.getLinkedBoardPath(card?.rawBody || card?.title || "", boardPath),
    };
  }

  getTimerKey(boardPath, card, occurrence = 1) {
    const stableText = card?.stableText || timerStableText(card?.title);
    return `${boardPath}::${stableText}::${Number(occurrence) || 1}`;
  }

  getTimer(key, durationMs) {
    const normalizedDuration = Math.max(0, Number(durationMs) || 0);
    let timer = this.data.timers[key];
    if (!timer || typeof timer !== "object") {
      timer = {
        durationMs: normalizedDuration,
        elapsedMs: 0,
        startedAt: null,
        running: false,
        resetDurationMs: normalizedDuration,
      };
      this.data.timers[key] = timer;
      this.queueSave();
      return timer;
    }

    timer.durationMs = Math.max(0, Number(timer.durationMs) || normalizedDuration);
    timer.elapsedMs = Math.max(0, Number(timer.elapsedMs) || 0);
    timer.running = Boolean(timer.running);
    timer.startedAt = Number.isFinite(Number(timer.startedAt)) ? Number(timer.startedAt) : null;
    if (!Number.isFinite(Number(timer.resetDurationMs)) || Number(timer.resetDurationMs) <= 0) {
      timer.resetDurationMs = normalizedDuration || timer.durationMs;
    }
    if (!timer.running && timer.elapsedMs === 0 && timer.durationMs !== normalizedDuration) {
      timer.durationMs = normalizedDuration;
      timer.resetDurationMs = normalizedDuration;
      this.queueSave();
    }
    return timer;
  }

  currentElapsed(timer, now = Date.now()) {
    if (!timer) return 0;
    const active = timer.running && Number.isFinite(Number(timer.startedAt))
      ? Math.max(0, now - Number(timer.startedAt))
      : 0;
    return Math.max(0, Number(timer.elapsedMs) || 0) + active;
  }

  formatTimerDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil((Number(milliseconds) || 0) / SECOND));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  formatCardDuration(milliseconds) {
    const value = Number(milliseconds) || 0;
    const overtime = value < 0;
    const totalSeconds = Math.max(0, Math.ceil(Math.abs(value) / SECOND));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const prefix = overtime ? "+" : "";
    if (seconds === 0) return `${prefix}${hours}:${String(minutes).padStart(2, "0")}`;
    return `${prefix}${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  formatCompactDuration(milliseconds) {
    const totalMinutes = Math.max(0, Math.ceil((Number(milliseconds) || 0) / MINUTE));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes} min`;
    if (minutes === 0) return `${hours} h`;
    return `${hours} h ${minutes} min`;
  }

  isDoneLane(title) {
    const value = canonical(title);
    return value === "termine" || value === "terminees" || value === "fait" ||
      value === "faits" || value === "done" || value === "archive";
  }

  parseBoardTasks(content, boardPath = "") {
    const tasks = [];
    const occurrences = new Map();
    for (const section of this.parseBoard(content)) {
      for (const card of section.cards) {
        const identity = this.getCardIdentity(boardPath, card, occurrences);
        tasks.push({
          ...card,
          key: identity.key,
          stableText: identity.stableText,
          occurrence: identity.occurrence,
          completed: card.checked,
          laneTitle: canonical(section.title),
          sublistPath: identity.sublistPath,
        });
      }
    }
    return tasks;
  }

  async ensureBoardTasks(boardPath, content) {
    if (!boardPath) return;
    if (typeof content === "string") {
      this.boardTasks.set(boardPath, this.parseBoardTasks(content, boardPath));
      this.sublistMarkers.set(boardPath, /^kanban-task-timer-sublist:\s*true\s*$/im.test(content));
      return;
    }
    if (this.boardTasks.has(boardPath)) return;
    if (this.boardTaskLoads.has(boardPath)) {
      await this.boardTaskLoads.get(boardPath);
      return;
    }
    const file = this.getMarkdownFile(boardPath);
    if (!file) return;
    const load = this.readFile(file)
      .then((value) => this.ensureBoardTasks(boardPath, value))
      .catch((error) => {
        console.error("Tâches Kanban: impossible de lire la note liée", error);
      })
      .finally(() => this.boardTaskLoads.delete(boardPath));
    this.boardTaskLoads.set(boardPath, load);
    await load;
  }

  isSublistBoard(path) {
    if (!path) return false;
    if (this.sublistMarkers.has(path)) return this.sublistMarkers.get(path);
    const file = this.getMarkdownFile(path);
    const frontmatter = file && this.app.metadataCache?.getFileCache?.(file)?.frontmatter;
    const marker = frontmatter?.["kanban-task-timer-sublist"];
    const result = marker === true || String(marker || "").toLowerCase() === "true";
    this.sublistMarkers.set(path, result);
    return result;
  }

  calculateRemainingForCard(card, identity, now = Date.now()) {
    if (!card || card.checked || !identity || this.isDoneLane(identity.sectionTitle)) return 0;
    if (identity.sublistPath) {
      const aggregate = this.calculateBoardAggregate(identity.sublistPath, now);
      return aggregate === null
        ? Math.max(0, identity.durationMs)
        : Math.max(0, aggregate.differenceMs);
    }
    const timer = this.getTimer(identity.key, identity.durationMs);
    return Math.max(0, timer.durationMs - this.currentElapsed(timer, now));
  }

  calculateSectionRemaining(boardPath, section, identities, now = Date.now()) {
    let total = 0;
    for (const card of section.cards) {
      const identity = identities.get(card.lineIndex);
      if (!identity) continue;
      identity.sectionTitle = section.title;
      total += this.calculateRemainingForCard(card, identity, now);
    }
    return total;
  }

  calculateBoardAggregate(boardPath, now = Date.now(), visited = new Set(), includeCompleted = false) {
    if (!boardPath || visited.has(boardPath)) return null;
    const tasks = this.boardTasks.get(boardPath);
    if (!tasks) {
      void this.ensureBoardTasks(boardPath);
      return null;
    }

    const nextVisited = new Set(visited);
    nextVisited.add(boardPath);
    let differenceMs = 0;
    let signedDifferenceMs = 0;
    let running = false;
    const refs = [];
    for (const task of tasks) {
      if (!includeCompleted && (task.completed || this.isDoneLane(task.laneTitle))) continue;
      if (task.sublistPath) {
        const nested = this.calculateBoardAggregate(task.sublistPath, now, nextVisited, includeCompleted);
        if (nested) {
          differenceMs += nested.differenceMs;
          signedDifferenceMs += nested.signedDifferenceMs;
          running ||= nested.running;
          refs.push(...nested.refs);
        } else {
          const durationMs = Math.max(0, Number(task.durationMs) || 0);
          differenceMs += durationMs;
          signedDifferenceMs += durationMs;
        }
        continue;
      }
      const timer = this.getTimer(task.key, task.durationMs);
      const timerDifferenceMs = timer.durationMs - this.currentElapsed(timer, now);
      differenceMs += Math.max(0, timerDifferenceMs);
      signedDifferenceMs += timerDifferenceMs;
      running ||= Boolean(timer.running);
      refs.push({
        key: task.key,
        boardPath,
        stableText: task.stableText,
        occurrence: task.occurrence,
        durationMs: task.durationMs,
        timer,
      });
    }
    return { differenceMs, signedDifferenceMs, running, refs };
  }

  renderTimerControls(cardElement, details) {
    const { view, boardPath, card, identity } = details;
    const row = cardElement.createDiv({ cls: "tasks-kanban-timer" });
    const toggle = row.createEl("button", {
      cls: "tasks-kanban-timer-toggle tasks-kanban-icon-button clickable-icon",
      attr: { type: "button", "aria-label": "Démarrer le minuteur" },
    });
    const display = row.createEl("input", {
      cls: "tasks-kanban-timer-display",
      attr: {
        type: "text",
        "aria-label": "Durée restante, cliquer pour modifier",
        autocomplete: "off",
        inputmode: "numeric",
      },
    });
    display.spellcheck = false;
    const control = {
      row,
      toggle,
      display,
      editing: false,
      view,
      details: {
        boardPath,
        card,
        identity,
        sectionTitle: details.section?.title || "",
      },
    };
    view.timerControls.set(identity.key, control);
    for (const eventName of ["pointerdown", "mousedown", "touchstart", "click"]) {
      row.addEventListener(eventName, (event) => event.stopPropagation());
    }
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      void this.toggleTimer(control);
    });
    display.addEventListener("focus", () => {
      if (display.readOnly) return;
      control.editing = true;
      display.classList.add("is-editing");
      display.select();
    });
    display.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        display.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        control.editing = false;
        display.classList.remove("is-editing");
        this.updateTimerControl(control);
        display.blur();
      }
    });
    display.addEventListener("blur", () => {
      if (!control.editing) return;
      control.editing = false;
      display.classList.remove("is-editing");
      void this.editTimerDuration(control, display.value);
    });
    this.updateTimerControl(control);
    return control;
  }

  updateTimerControl(control) {
    if (!control?.row?.isConnected && !control?.row?.parentElement) return;
    const { boardPath, card, identity, sectionTitle } = control.details;
    identity.sectionTitle = sectionTitle;
    const sublistPath = identity.sublistPath;
    let remainingMs = identity.durationMs;
    let running = false;
    let loading = false;
    if (sublistPath) {
      const aggregate = this.calculateBoardAggregate(sublistPath, Date.now());
      if (aggregate) {
        remainingMs = aggregate.signedDifferenceMs;
        running = aggregate.running;
      } else {
        loading = true;
      }
    } else {
      const timer = this.getTimer(identity.key, identity.durationMs);
      remainingMs = timer.durationMs - this.currentElapsed(timer);
      running = timer.running;
    }

    const icon = running ? "pause" : "play";
    if (control.toggle.dataset.iconName !== icon) {
      control.toggle.replaceChildren();
      setIcon(control.toggle, icon);
      control.toggle.dataset.iconName = icon;
    }
    const label = loading
      ? "Chargement du temps lié"
      : running
        ? "Mettre le minuteur en pause"
        : sublistPath
          ? "Démarrer le minuteur de la liste liée"
          : "Démarrer le minuteur";
    control.toggle.disabled = loading;
    control.toggle.setAttribute("aria-label", label);
    control.toggle.setAttribute("title", label);
    control.toggle.setAttribute("aria-pressed", String(running));
    control.display.readOnly = Boolean(sublistPath);
    control.display.setAttribute(
      "aria-label",
      sublistPath
        ? "Durée restante de la liste liée"
        : "Durée restante, cliquer pour modifier"
    );
    control.display.setAttribute(
      "title",
      sublistPath
        ? "Durée calculée à partir de la liste liée"
        : "Cliquer pour modifier la durée restante (H:MM ou H:MM:SS)"
    );
    if (!control.editing) {
      control.display.value = loading ? "…" : this.formatCardDuration(remainingMs);
    }
    control.display.classList.toggle("is-finished", !loading && remainingMs <= 0);
    control.display.disabled = loading;
    control.row.classList.toggle("is-running", running);
    control.row.classList.toggle("is-linked", Boolean(sublistPath));
    control.row.classList.toggle("is-finished", !loading && remainingMs <= 0);
  }

  async editTimerDuration(control, value) {
    const identity = control?.details?.identity;
    if (!identity || identity.sublistPath) return;
    const durationMs = this.parseDurationInput(value);
    if (!Number.isFinite(durationMs)) {
      new Notice("Utilisez le format H:MM ou H:MM:SS.");
      this.updateTimerControl(control);
      return;
    }

    const ref = this.makeTimerRef(control);
    const timer = ref.timer;
    const keepRunning = Boolean(timer.running) && durationMs > 0;
    timer.durationMs = durationMs;
    timer.elapsedMs = 0;
    timer.startedAt = keepRunning ? Date.now() : null;
    timer.running = keepRunning;
    timer.resetDurationMs = durationMs;
    await this.writeRemainingTimeToTask(ref, durationMs);
    this.queueSave(true);
    for (const view of this.views) view.updateTimerControls();
  }

  async toggleForcedStart(control) {
    const key = control?.details?.identity?.key;
    if (!key) return;
    const oldInput = control.row.querySelector(".tasks-kanban-timer-forced-input");
    if (oldInput) {
      oldInput.remove();
      return;
    }
    const input = control.row.createEl("input", {
      cls: "tasks-kanban-timer-forced-input",
      attr: {
        type: "text",
        placeholder: "HH:MM",
        "aria-label": "Heure de début imposée",
      },
    });
    input.inputMode = "numeric";
    input.value = this.data.forcedStarts[key] || "";
    const commit = () => {
      const value = input.value.trim();
      if (value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        new Notice("Utilisez le format HH:MM.");
        input.focus();
        return;
      }
      if (value) this.data.forcedStarts[key] = value;
      else delete this.data.forcedStarts[key];
      input.remove();
      this.queueSave(true);
      for (const view of this.views) view.updateTimerControls();
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
      if (event.key === "Escape") input.remove();
    });
    input.focus();
  }

  makeTimerRef(control) {
    const identity = control.details.identity;
    return {
      key: identity.key,
      boardPath: control.details.boardPath,
      stableText: identity.stableText,
      occurrence: identity.occurrence,
      durationMs: identity.durationMs,
      timer: this.getTimer(identity.key, identity.durationMs),
    };
  }

  async toggleTimer(control) {
    const identity = control?.details?.identity;
    if (!identity) return;
    if (identity.sublistPath) {
      await this.toggleSublistTimer(identity.sublistPath);
      return;
    }
    const ref = this.makeTimerRef(control);
    if (ref.timer.running) {
      await this.pauseTimerRef(ref);
    } else {
      await this.pauseOtherTimersInBoard(ref.boardPath, ref.key);
      ref.timer.resetDurationMs = ref.timer.durationMs;
      ref.timer.elapsedMs = 0;
      ref.timer.startedAt = Date.now();
      ref.timer.running = true;
    }
    this.queueSave(true);
    for (const view of this.views) view.updateTimerControls();
  }

  async toggleSublistTimer(sublistPath) {
    await this.ensureBoardTasks(sublistPath);
    const aggregate = this.calculateBoardAggregate(sublistPath);
    if (!aggregate || aggregate.refs.length === 0) {
      new Notice("La liste liée ne contient aucune tâche minutée.");
      return;
    }
    if (aggregate.running) {
      for (const ref of aggregate.refs.filter((item) => item.timer.running)) {
        await this.pauseTimerRef(ref, { skipParentSync: true });
      }
      await this.syncParentCardDurations(sublistPath);
    } else {
      for (const ref of aggregate.refs) ref.timer.resetDurationMs = ref.timer.durationMs;
      const next = aggregate.refs.find(
        (ref) => ref.timer.durationMs - this.currentElapsed(ref.timer) > 0
      ) || aggregate.refs[0];
      next.timer.elapsedMs = 0;
      next.timer.startedAt = Date.now();
      next.timer.running = true;
    }
    this.queueSave(true);
    for (const view of this.views) view.updateTimerControls();
  }

  async pauseOtherTimersInBoard(boardPath, exceptKey) {
    await this.ensureBoardTasks(boardPath);
    const aggregate = this.calculateBoardAggregate(boardPath);
    if (!aggregate) return;
    for (const ref of aggregate.refs) {
      if (ref.key !== exceptKey && ref.timer.running) {
        await this.pauseTimerRef(ref, { skipParentSync: true });
      }
    }
  }

  async pauseTimerRef(ref, options = {}) {
    const timer = ref?.timer || this.data.timers[ref?.key];
    if (!timer?.running) return;
    const elapsed = this.currentElapsed(timer);
    const originalDuration = Math.max(0, Number(timer.durationMs) || 0);
    const remainingMs = Math.max(0, originalDuration - elapsed);
    timer.startedAt = null;
    timer.running = false;
    if (remainingMs > 0) {
      const checkpointMs = Math.ceil(remainingMs / SECOND) * SECOND;
      timer.durationMs = checkpointMs;
      timer.elapsedMs = 0;
      await this.writeRemainingTimeToTask(ref, checkpointMs);
    } else {
      timer.elapsedMs = elapsed;
    }
    this.queueSave(true);
    if (!options.skipParentSync && this.isSublistBoard(ref.boardPath)) {
      await this.syncParentCardDurations(ref.boardPath);
    }
  }

  async resetTimer(control) {
    const identity = control?.details?.identity;
    if (!identity) return;
    if (identity.sublistPath) {
      await this.ensureBoardTasks(identity.sublistPath);
      const aggregate = this.calculateBoardAggregate(identity.sublistPath, Date.now(), new Set(), true);
      if (!aggregate) return;
      for (const ref of aggregate.refs) {
        const restored = Number(ref.timer.resetDurationMs) > 0
          ? Number(ref.timer.resetDurationMs)
          : Number(ref.durationMs) || 0;
        ref.timer.durationMs = restored;
        ref.timer.elapsedMs = 0;
        ref.timer.startedAt = null;
        ref.timer.running = false;
        ref.timer.resetDurationMs = restored;
        await this.writeRemainingTimeToTask(ref, restored);
      }
      await this.syncParentCardDurations(identity.sublistPath);
    } else {
      const ref = this.makeTimerRef(control);
      const restored = Number(ref.timer.resetDurationMs) > 0
        ? Number(ref.timer.resetDurationMs)
        : Number(ref.durationMs) || 0;
      ref.timer.durationMs = restored;
      ref.timer.elapsedMs = 0;
      ref.timer.startedAt = null;
      ref.timer.running = false;
      ref.timer.resetDurationMs = restored;
      await this.writeRemainingTimeToTask(ref, restored);
      if (this.isSublistBoard(ref.boardPath)) await this.syncParentCardDurations(ref.boardPath);
    }
    this.queueSave(true);
    for (const view of this.views) view.updateTimerControls();
  }

  async writeRemainingTimeToTask(ref, remainingMs) {
    const file = this.getMarkdownFile(ref?.boardPath);
    if (!file || !ref?.stableText) return false;
    const targetOccurrence = Number(ref.occurrence) || 1;
    const nextDuration = this.formatCardDuration(remainingMs);
    const occurrences = new Map();
    let changed = false;
    await this.processFile(file, (content) => {
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const parsed = parseCardLine(lines[index], index);
        if (!parsed) continue;
        const occurrence = (occurrences.get(parsed.stableText) || 0) + 1;
        occurrences.set(parsed.stableText, occurrence);
        if (parsed.stableText !== ref.stableText || occurrence !== targetOccurrence) continue;
        const duration = durationFromBody(parsed.rawBody);
        let nextBody;
        if (duration) {
          const separator = duration.match[0].slice(0, duration.match[0].indexOf(duration.match[1]));
          nextBody = `${parsed.rawBody.slice(0, duration.match.index)}${separator}${nextDuration}${parsed.rawBody.slice(duration.match.index + duration.match[0].length)}`;
        } else {
          nextBody = `${parsed.rawBody.trimEnd()} — ${nextDuration}`;
        }
        const nextLine = `${parsed.prefix}${nextBody}`;
        if (nextLine !== lines[index]) {
          lines[index] = nextLine;
          changed = true;
        }
        break;
      }
      return lines.join(content.includes("\r\n") ? "\r\n" : "\n");
    });
    if (changed) {
      this.boardTasks.delete(ref.boardPath);
      for (const view of this.views) view.updateTimerControls();
    }
    return changed;
  }

  async syncParentCardDurations(sublistPath) {
    await this.ensureBoardTasks(sublistPath);
    const aggregate = this.calculateBoardAggregate(sublistPath);
    if (!aggregate) return;
    const nextDuration = this.formatCardDuration(Math.max(0, aggregate.differenceMs));
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path === sublistPath) continue;
      await this.processFile(file, (content) => {
        const lines = content.split(/\r?\n/);
        let changed = false;
        for (let index = 0; index < lines.length; index += 1) {
          const parsed = parseCardLine(lines[index], index);
          if (!parsed || this.getLinkedBoardPath(parsed.rawBody, file.path) !== sublistPath) continue;
          const duration = durationFromBody(parsed.rawBody);
          const nextBody = duration
            ? `${parsed.rawBody.slice(0, duration.match.index)}${duration.match[0].slice(0, duration.match[0].indexOf(duration.match[1]))}${nextDuration}${parsed.rawBody.slice(duration.match.index + duration.match[0].length)}`
            : `${parsed.rawBody.trimEnd()} — ${nextDuration}`;
          const nextLine = `${parsed.prefix}${nextBody}`;
          if (nextLine !== lines[index]) {
            lines[index] = nextLine;
            changed = true;
          }
        }
        return lines.join(content.includes("\r\n") ? "\r\n" : "\n");
      });
    }
  }

  parseDurationInput(value) {
    const match = String(value || "").trim().match(/^\+?(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3] || 0);
    return ((hours * 60 + minutes) * 60 + seconds) * SECOND;
  }

  async addCardToBoard(path, laneTitle, title, durationInput) {
    const file = this.getMarkdownFile(path);
    const durationMs = this.parseDurationInput(durationInput);
    const cleanTitle = String(title || "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!file || !cleanTitle || !Number.isFinite(durationMs)) {
      new Notice("Indiquez un titre et une durée au format H:MM ou H:MM:SS.");
      return false;
    }

    let changed = false;
    await this.processFile(file, (content) => {
      const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      const section = this.parseBoard(content).find(
        (candidate) => canonical(candidate.title) === canonical(laneTitle)
      );
      if (!section) return content;
      let insertAt = section.end;
      while (insertAt > section.start + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
      lines.splice(insertAt, 0, `- [ ] ${cleanTitle} — ${this.formatCardDuration(durationMs)}`);
      changed = true;
      return lines.join(lineEnding);
    });
    if (!changed) {
      new Notice(`La colonne « ${laneTitle} » n’existe plus.`);
      return false;
    }
    this.boardTasks.delete(path);
    this.refreshViews(path);
    new Notice(`Carte ajoutée dans « ${laneTitle} ».`);
    return true;
  }

  isBoardContent(content) {
    return BOARD_MARKER.test(content) || STANDALONE_MARKER.test(content) || SETTINGS_MARKER.test(content);
  }

  parseBoard(content) {
    const lines = String(content || "").split(/\r?\n/);
    const settingsStart = lines.findIndex((line) => /^%%\s*kanban:settings\s*$/.test(line));
    const headings = [];
    lines.forEach((line, index) => {
      const match = line.match(HEADING_PATTERN);
      if (match) headings.push({ title: match[1].trim(), start: index });
    });

    return headings.map((heading, index) => {
      const nextHeading = headings[index + 1]?.start ?? lines.length;
      const end = Math.min(nextHeading, settingsStart >= 0 ? settingsStart : lines.length);
      const occurrence = headings
        .slice(0, index + 1)
        .filter((candidate) => canonical(candidate.title) === canonical(heading.title)).length;
      const cards = [];
      for (let lineIndex = heading.start + 1; lineIndex < end; lineIndex += 1) {
        const card = parseCardLine(lines[lineIndex], lineIndex);
        if (card) cards.push(card);
      }
      return {
        title: heading.title,
        start: heading.start,
        end,
        key: `${canonical(heading.title)}::${occurrence}`,
        cards,
      };
    });
  }

  isLaneHidden(path, section) {
    const state = this.data.hiddenLanes[path] || {};
    if (typeof state[section.key] === "boolean") return state[section.key];
    return canonical(section.title) === canonical("autre jour");
  }

  setLaneHidden(path, section, hidden) {
    if (!this.data.hiddenLanes[path]) this.data.hiddenLanes[path] = {};
    this.data.hiddenLanes[path][section.key] = Boolean(hidden);
  }

  async processFile(file, processor) {
    if (typeof this.app.vault.process === "function") {
      return this.app.vault.process(file, processor);
    }
    const current = await this.app.vault.cachedRead(file);
    const next = processor(current);
    if (next !== current) await this.app.vault.modify(file, next);
    return next;
  }

  async sortBoard(path, order) {
    const file = this.getMarkdownFile(path);
    if (!file) return;
    let changed = false;
    await this.processFile(file, (content) => {
      const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      const sections = this.parseBoard(content);
      for (const section of sections) {
        const indexes = [];
        const cardLines = [];
        for (let index = section.start + 1; index < section.end; index += 1) {
          const card = parseCardLine(lines[index], index);
          if (!card) continue;
          indexes.push(index);
          cardLines.push(lines[index]);
        }
        if (cardLines.length < 2) continue;
        cardLines.sort((a, b) => {
          const left = parseCardLine(a)?.durationMs;
          const right = parseCardLine(b)?.durationMs;
          const leftValue = left === null || left === undefined ? Number.POSITIVE_INFINITY : left;
          const rightValue = right === null || right === undefined ? Number.POSITIVE_INFINITY : right;
          const comparison = leftValue - rightValue;
          return order === "desc" ? -comparison : comparison;
        });
        indexes.forEach((lineIndex, cardIndex) => {
          if (lines[lineIndex] !== cardLines[cardIndex]) {
            lines[lineIndex] = cardLines[cardIndex];
            changed = true;
          }
        });
      }
      return lines.join(lineEnding);
    });
    if (changed) this.refreshViews(path);
  }

  refreshViews(path) {
    for (const view of this.views) {
      if (view.filePath === path) void view.render();
    }
  }

  locateCardLine(content, card) {
    const lines = String(content || "").split(/\r?\n/);
    if (Number.isInteger(card.lineIndex) && lines[card.lineIndex] === card.rawLine) return card.lineIndex;
    const exact = lines.findIndex((line) => line === card.rawLine);
    if (exact >= 0) return exact;
    const candidates = lines
      .map((line, index) => ({ parsed: parseCardLine(line, index), index }))
      .filter(({ parsed }) => parsed && parsed.stableTitle === card.stableTitle);
    return candidates[0]?.index ?? -1;
  }

  async updateCardLabel(path, card, identity, title) {
    const cleanTitle = String(title || "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleanTitle) {
      new Notice("Le libellé ne peut pas être vide.");
      return false;
    }
    const file = this.getMarkdownFile(path);
    if (!file || !card) {
      new Notice("La carte n’est plus disponible.");
      return false;
    }

    let changed = false;
    let lineIndex = -1;
    let updatedContent = "";
    await this.processFile(file, (content) => {
      const lines = content.split(/\r?\n/);
      const index = this.locateCardLine(content, card);
      if (index < 0) return content;
      const parsed = parseCardLine(lines[index], index);
      if (!parsed) return content;
      lineIndex = index;
      const duration = parsed.durationToken ? ` ${parsed.durationToken}` : "";
      const nextLine = `${parsed.prefix}${cleanTitle}${duration}`;
      if (nextLine === lines[index]) return content;
      lines[index] = nextLine;
      changed = true;
      updatedContent = lines.join(content.includes("\r\n") ? "\r\n" : "\n");
      return updatedContent;
    });

    if (!changed) return lineIndex >= 0;
    this.boardTasks.delete(path);
    this.migrateTimerStateAfterLabelEdit(path, lineIndex, identity?.key, updatedContent);
    this.refreshViews(path);
    new Notice("Libellé modifié.");
    return true;
  }

  migrateTimerStateAfterLabelEdit(path, lineIndex, oldKey, updatedContent) {
    if (!oldKey || lineIndex < 0 || !updatedContent) return;
    const nextTask = this.parseBoardTasks(updatedContent, path)
      .find((task) => task.lineIndex === lineIndex);
    if (!nextTask || nextTask.key === oldKey) return;

    const hasTimer = Object.prototype.hasOwnProperty.call(this.data.timers, oldKey);
    const hasNextTimer = Object.prototype.hasOwnProperty.call(this.data.timers, nextTask.key);
    if (hasTimer && !hasNextTimer) {
      this.data.timers[nextTask.key] = this.data.timers[oldKey];
      delete this.data.timers[oldKey];
    }

    const hasForcedStart = Object.prototype.hasOwnProperty.call(this.data.forcedStarts, oldKey);
    const hasNextForcedStart = Object.prototype.hasOwnProperty.call(this.data.forcedStarts, nextTask.key);
    if (hasForcedStart && !hasNextForcedStart) {
      this.data.forcedStarts[nextTask.key] = this.data.forcedStarts[oldKey];
      delete this.data.forcedStarts[oldKey];
    }
    if (hasTimer || hasForcedStart) this.queueSave();
  }

  async updateCardCheck(path, card, checked) {
    const file = this.getMarkdownFile(path);
    if (!file) return;
    let changed = false;
    await this.processFile(file, (content) => {
      const lines = content.split(/\r?\n/);
      const index = this.locateCardLine(content, card);
      if (index < 0) return content;
      const next = lines[index].replace(/^(\s*-\s+\[)[^\]](\]\s+)/, `$1${checked ? "x" : " "}$2`);
      if (next === lines[index]) return content;
      lines[index] = next;
      changed = true;
      return lines.join(content.includes("\r\n") ? "\r\n" : "\n");
    });
    if (changed) this.refreshViews(path);
  }

  migrateTimerStateAfterCardDeletion(path, tasks, removedTask, fallbackIdentity) {
    if (!removedTask && !fallbackIdentity) return;

    const stableText = removedTask?.stableText || fallbackIdentity?.stableText || "";
    const removedOccurrence = Number(
      removedTask?.occurrence || fallbackIdentity?.occurrence || 0
    );
    const removedKey = removedTask?.key || fallbackIdentity?.key || "";
    if (!stableText || !removedOccurrence) return;

    const moves = tasks
      .filter((task) => task.stableText === stableText && Number(task.occurrence) > removedOccurrence)
      .map((task) => ({
        oldKey: task.key,
        newKey: this.getTimerKey(path, task, Number(task.occurrence) - 1),
      }));
    const timerStates = new Map();
    const forcedStartStates = new Map();
    for (const move of moves) {
      if (Object.prototype.hasOwnProperty.call(this.data.timers, move.oldKey)) {
        timerStates.set(move.oldKey, this.data.timers[move.oldKey]);
      }
      if (Object.prototype.hasOwnProperty.call(this.data.forcedStarts, move.oldKey)) {
        forcedStartStates.set(move.oldKey, this.data.forcedStarts[move.oldKey]);
      }
    }

    let changed = false;
    const keysToRemove = new Set([
      removedKey,
      ...moves.map((move) => move.oldKey),
    ]);
    for (const key of keysToRemove) {
      if (!key) continue;
      if (Object.prototype.hasOwnProperty.call(this.data.timers, key)) {
        delete this.data.timers[key];
        changed = true;
      }
      if (Object.prototype.hasOwnProperty.call(this.data.forcedStarts, key)) {
        delete this.data.forcedStarts[key];
        changed = true;
      }
    }

    for (const move of moves) {
      if (timerStates.has(move.oldKey)) {
        this.data.timers[move.newKey] = timerStates.get(move.oldKey);
        changed = true;
      }
      if (forcedStartStates.has(move.oldKey)) {
        this.data.forcedStarts[move.newKey] = forcedStartStates.get(move.oldKey);
        changed = true;
      }
    }

    if (changed) this.queueSave(true);
  }

  async deleteCard(path, card, identity) {
    const file = this.getMarkdownFile(path);
    if (!file || !card) {
      new Notice("La carte n’est plus disponible.");
      return false;
    }

    let removedTitle = card.title;
    let removedTask = null;
    let tasksBeforeDeletion = [];
    let changed = false;
    await this.processFile(file, (content) => {
      const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      const index = this.locateCardLine(content, card);
      if (index < 0) return content;
      const parsed = parseCardLine(lines[index], index);
      if (!parsed) return content;

      tasksBeforeDeletion = this.parseBoardTasks(content, path);
      removedTask = tasksBeforeDeletion.find((task) => task.lineIndex === index) || {
        ...parsed,
        key: identity?.key || "",
        stableText: identity?.stableText || parsed.stableText,
        occurrence: identity?.occurrence || 1,
      };
      removedTitle = parsed.title;
      lines.splice(index, 1);
      changed = true;
      return lines.join(lineEnding);
    });

    if (!changed) {
      new Notice("La carte n’existe plus dans la note.");
      return false;
    }

    this.migrateTimerStateAfterCardDeletion(
      path,
      tasksBeforeDeletion,
      removedTask,
      identity
    );
    this.boardTasks.delete(path);
    this.refreshViews(path);
    if (this.isSublistBoard(path)) await this.syncParentCardDurations(path);
    new Notice(`Carte « ${removedTitle} » supprimée.`);
    return true;
  }

  extractWikiLinks(text) {
    WIKI_LINK_PATTERN.lastIndex = 0;
    return Array.from(String(text || "").matchAll(WIKI_LINK_PATTERN)).map((match) => ({
      target: match[1].trim(),
      label: (match[2] || match[1]).trim(),
      raw: match[0],
    }));
  }

  resolveLink(target, sourcePath) {
    const normalizedTarget = String(target || "").replace(/\.md$/i, "");
    const linked = this.app.metadataCache?.getFirstLinkpathDest?.(normalizedTarget, sourcePath);
    if (linked instanceof TFile) return linked;
    const direct = this.getMarkdownFile(`${normalizedTarget}.md`);
    if (direct) return direct;
    return this.getMarkdownFile(normalizePath(`${sourcePath.split("/").slice(0, -1).join("/")}/${normalizedTarget}.md`));
  }

  getLinkedBoardPath(body, sourcePath) {
    for (const link of this.extractWikiLinks(body)) {
      const file = this.resolveLink(link.target, sourcePath);
      if (!file) continue;
      const frontmatter = this.app.metadataCache?.getFileCache?.(file)?.frontmatter;
      const isBoard = frontmatter?.["kanban-plugin"] === "board" ||
        frontmatter?.["tasks-kanban"] === "board";
      const isSublist = this.isSublistBoard(file.path) ||
        file.path.toLocaleLowerCase().startsWith(`${SUBLIST_FOLDER.toLocaleLowerCase()}/`);
      if (isBoard || isSublist) return file.path;
    }
    return "";
  }

  async createOrOpenSublist(sourcePath, card) {
    const existing = this.getLinkedBoardPath(card.rawBody, sourcePath);
    if (existing) {
      await this.openBoard(existing);
      return;
    }

    try {
      let folder = this.app.vault.getAbstractFileByPath(SUBLIST_FOLDER);
      if (!folder) folder = await this.app.vault.createFolder(SUBLIST_FOLDER);
      if (!folder) throw new Error("dossier indisponible");

      const baseName = this.slugify(card.title) || "Sous-tâches";
      let path = normalizePath(`${SUBLIST_FOLDER}/${baseName}.md`);
      let suffix = 2;
      while (this.app.vault.getAbstractFileByPath(path)) {
        path = normalizePath(`${SUBLIST_FOLDER}/${baseName} (${suffix}).md`);
        suffix += 1;
      }
      const content = [
        "---",
        "kanban-plugin: board",
        "tasks-kanban: board",
        "---",
        "",
        `## ${DEFAULT_LANE}`,
        "",
        "- [ ] À détailler — 1:00",
        "",
        "## Terminé",
        "",
        "",
      ].join("\n");
      await this.app.vault.create(path, content);

      const file = this.getMarkdownFile(sourcePath);
      if (!file) return;
      let changed = false;
      await this.processFile(file, (current) => {
        const lines = current.split(/\r?\n/);
        const index = this.locateCardLine(current, card);
        if (index < 0) return current;
        const line = lines[index];
        const parsed = parseCardLine(line, index);
        if (!parsed) return current;
        const link = `[[${path.replace(/\.md$/i, "")}]]`;
        const duration = parsed.durationToken ? ` ${parsed.durationToken}` : "";
        const nextBody = `${parsed.title} ${link}${duration}`.trim();
        lines[index] = `${parsed.prefix}${nextBody}`;
        changed = lines[index] !== line;
        return lines.join(current.includes("\r\n") ? "\r\n" : "\n");
      });
      if (changed) this.refreshViews(sourcePath);
      await this.openBoard(path);
      new Notice(`Liste liée créée : ${path}`);
    } catch (error) {
      console.error("Tâches Kanban: impossible de créer la sous-liste", error);
      new Notice("Impossible de créer la liste liée.");
    }
  }

  slugify(value) {
    const clean = String(value || "")
      .replace(WIKI_LINK_PATTERN, "$2")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .replace(/\s+/g, " ");
    return clean.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "Sous-taches";
  }

  async getDestinationBoards(sourcePath) {
    const boards = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path === sourcePath || file.path.startsWith(".trash/")) continue;
      const content = await this.readFile(file);
      if (content.trim() === "" || this.isBoardContent(content)) boards.push(file);
    }
    return boards.sort((a, b) => a.path.localeCompare(b.path, "fr"));
  }

  getAvailableLaneTitle(content, preferred) {
    const titles = new Set(this.parseBoard(content).map((section) => canonical(section.title)));
    if (!titles.has(canonical(preferred))) return preferred;
    let suffix = 2;
    while (titles.has(canonical(`${preferred} (${suffix})`))) suffix += 1;
    return `${preferred} (${suffix})`;
  }

  appendCardToBoard(content, laneTitle, line) {
    if (String(content || "").trim() === "") {
      return [
        "---",
        "kanban-plugin: board",
        "tasks-kanban: board",
        "---",
        "",
        `## ${laneTitle}`,
        "",
        line.trimStart(),
        "",
      ].join("\n");
    }

    const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = content.split(/\r?\n/);
    const section = this.parseBoard(content).find(
      (candidate) => canonical(candidate.title) === canonical(laneTitle)
    );
    if (!section) return null;
    let insertAt = section.end;
    while (insertAt > section.start + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
    lines.splice(insertAt, 0, line.trimStart());
    return lines.join(lineEnding);
  }

  async moveCardWithinBoard(sourcePath, card, targetSectionKey, targetCard, insertBefore) {
    const file = this.getMarkdownFile(sourcePath);
    if (!file) return;

    let changed = false;
    await this.processFile(file, (content) => {
      const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      const sourceIndex = this.locateCardLine(content, card);
      if (sourceIndex < 0) return content;

      const movedLine = lines[sourceIndex];
      if (targetCard && targetCard.lineIndex === card.lineIndex) return content;
      lines.splice(sourceIndex, 1);

      const intermediate = lines.join(lineEnding);
      const destination = this.parseBoard(intermediate).find(
        (section) => section.key === targetSectionKey
      );
      if (!destination) return content;

      let insertAt;
      if (targetCard) {
        const originalTargetIndex = Number(targetCard.lineIndex);
        const adjustedTargetIndex = sourceIndex < originalTargetIndex
          ? originalTargetIndex - 1
          : originalTargetIndex;
        let targetIndex = adjustedTargetIndex;
        if (lines[targetIndex] !== targetCard.rawLine) {
          targetIndex = lines.findIndex((line, index) =>
            index > destination.start && index < destination.end && line === targetCard.rawLine
          );
        }
        if (targetIndex < 0) return content;
        insertAt = targetIndex + (insertBefore ? 0 : 1);
      } else {
        insertAt = destination.end;
        while (insertAt > destination.start + 1 && lines[insertAt - 1].trim() === "") {
          insertAt -= 1;
        }
      }

      lines.splice(insertAt, 0, movedLine);
      changed = true;
      return lines.join(lineEnding);
    });

    if (!changed) return;
    this.boardTasks.delete(sourcePath);
    this.refreshViews(sourcePath);
    new Notice("Carte déplacée.");
  }

  async moveCardToBoard(sourcePath, card, targetPath, targetLane) {
    const sourceFile = this.getMarkdownFile(sourcePath);
    const targetFile = this.getMarkdownFile(targetPath);
    if (!sourceFile || !targetFile || sourcePath === targetPath) {
      new Notice("La note de destination est invalide.");
      return;
    }

    const sourceContent = await this.readFile(sourceFile);
    const sourceLines = sourceContent.split(/\r?\n/);
    const sourceIndex = this.locateCardLine(sourceContent, card);
    if (sourceIndex < 0) {
      new Notice("La carte n’existe plus dans la note source.");
      return;
    }
    const movedLine = sourceLines[sourceIndex].trimStart();
    let inserted = false;
    await this.processFile(targetFile, (content) => {
      const next = this.appendCardToBoard(content, targetLane, movedLine);
      if (next === null) return content;
      inserted = true;
      return next;
    });
    if (!inserted) {
      new Notice("La note cible doit être vide ou contenir un tableau Kanban.");
      return;
    }

    let removed = false;
    await this.processFile(sourceFile, (content) => {
      const lines = content.split(/\r?\n/);
      const index = this.locateCardLine(content, card);
      if (index < 0) return content;
      lines.splice(index, 1);
      removed = true;
      return lines.join(content.includes("\r\n") ? "\r\n" : "\n");
    });
    this.refreshViews(sourcePath);
    this.refreshViews(targetPath);
    if (removed) new Notice(`Carte déplacée vers « ${targetPath} »`);
    else new Notice(`Carte copiée vers « ${targetPath} » ; la source a changé entre-temps.`);
  }

  async moveLaneToBoard(sourcePath, section, targetPath, targetLane) {
    const sourceFile = this.getMarkdownFile(sourcePath);
    const targetFile = this.getMarkdownFile(targetPath);
    if (!sourceFile || !targetFile || sourcePath === targetPath) {
      new Notice("La note de destination est invalide.");
      return;
    }
    const sourceContent = await this.readFile(sourceFile);
    const sourceLines = sourceContent.split(/\r?\n/);
    const currentSection = this.parseBoard(sourceContent).find((candidate) => candidate.key === section.key);
    if (!currentSection) {
      new Notice("La colonne n’existe plus dans la note source.");
      return;
    }
    const block = sourceLines.slice(currentSection.start, currentSection.end);
    if (block.length === 0) return;
    let inserted = false;
    await this.processFile(targetFile, (content) => {
      const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
      if (content.trim() === "") {
        inserted = true;
        return [
          "---",
          "kanban-plugin: board",
          "tasks-kanban: board",
          "---",
          "",
          `## ${targetLane}`,
          "",
          ...block.slice(1),
          "",
        ].join(lineEnding);
      }
      const lines = content.split(/\r?\n/);
      const destination = this.parseBoard(content).find(
        (candidate) => canonical(candidate.title) === canonical(targetLane)
      );
      if (!destination) return content;
      let insertAt = destination.end;
      while (insertAt > destination.start + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
      lines.splice(insertAt, 0, ...block.slice(1));
      inserted = true;
      return lines.join(lineEnding);
    });
    if (!inserted) {
      new Notice("La note cible doit être vide ou contenir la colonne choisie.");
      return;
    }

    let removed = false;
    await this.processFile(sourceFile, (content) => {
      const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      const current = this.parseBoard(content).find((candidate) => candidate.key === section.key);
      if (!current) return content;
      lines.splice(current.start, current.end - current.start);
      removed = true;
      return lines.join(lineEnding);
    });
    this.refreshViews(sourcePath);
    this.refreshViews(targetPath);
    if (removed) new Notice(`Colonne déplacée vers « ${targetPath} »`);
    else new Notice(`Colonne copiée vers « ${targetPath} » ; la source a changé entre-temps.`);
  }

  async deleteLane(path, section) {
    const file = this.getMarkdownFile(path);
    if (!file) {
      new Notice("La note de cette liste n’est plus disponible.");
      return false;
    }

    let removedTitle = section.title;
    let removedKeys = [];
    let changed = false;
    await this.processFile(file, (content) => {
      const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      const current = this.parseBoard(content).find((candidate) => candidate.key === section.key);
      if (!current) return content;
      removedTitle = current.title;
      const removedLineIndexes = new Set(current.cards.map((card) => card.lineIndex));
      removedKeys = this.parseBoardTasks(content, path)
        .filter((task) => removedLineIndexes.has(task.lineIndex))
        .map((task) => task.key);
      lines.splice(current.start, current.end - current.start);
      changed = true;
      return lines.join(lineEnding);
    });

    if (!changed) {
      new Notice("La liste n’existe plus dans la note.");
      return false;
    }

    let storeChanged = false;
    for (const key of removedKeys) {
      if (Object.prototype.hasOwnProperty.call(this.data.timers, key)) {
        delete this.data.timers[key];
        storeChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(this.data.forcedStarts, key)) {
        delete this.data.forcedStarts[key];
        storeChanged = true;
      }
    }
    if (storeChanged) this.queueSave(true);
    this.boardTasks.delete(path);
    this.refreshViews(path);
    new Notice(`Liste « ${removedTitle} » supprimée.`);
    return true;
  }

  async createBoard(title, destinationFolder) {
    const fileName = String(title || "").trim().replace(/\.md$/i, "");
    if (!fileName) {
      new Notice("Indiquez un nom de tableau.");
      return false;
    }
    if (/[\\/:*?"<>|]/.test(fileName)) {
      new Notice("Le nom du tableau contient un caractère non autorisé.");
      return false;
    }
    const folderPath = String(destinationFolder || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (folderPath.includes("..")) {
      new Notice("Indiquez un dossier du coffre sans « .. ».");
      return false;
    }
    const destination = folderPath ? this.app.vault.getAbstractFileByPath(folderPath) : null;
    if (folderPath && (!destination || destination.children === undefined)) {
      new Notice("Le dossier de destination n’existe pas.");
      return false;
    }
    const path = normalizePath(folderPath ? `${folderPath}/${fileName}.md` : `${fileName}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice("Un tableau porte déjà ce nom dans ce dossier.");
      return false;
    }
    try {
      await this.app.vault.create(path, [
        "---",
        "kanban-plugin: board",
        "tasks-kanban: board",
        "---",
        "",
        `## ${DEFAULT_LANE}`,
        "",
      ].join("\n"));
      await this.openBoard(path);
      new Notice(`Tableau « ${fileName} » créé.`);
      return true;
    } catch (error) {
      console.error("Tâches Kanban: impossible de créer le tableau", error);
      new Notice("Impossible de créer le tableau.");
      return false;
    }
  }

  async moveBoard(path, destinationFolder) {
    const file = this.getMarkdownFile(path);
    if (!file) {
      new Notice("Le tableau n’est plus disponible.");
      return false;
    }
    const folderPath = String(destinationFolder || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (folderPath.includes("..")) {
      new Notice("Indiquez un dossier du coffre sans « .. ».");
      return false;
    }
    const destination = folderPath ? this.app.vault.getAbstractFileByPath(folderPath) : null;
    if (folderPath && (!destination || destination.children === undefined)) {
      new Notice("Le dossier de destination n’existe pas.");
      return false;
    }
    const targetPath = normalizePath(folderPath ? `${folderPath}/${file.name}` : file.name);
    if (targetPath === file.path) {
      new Notice("Le tableau est déjà dans ce dossier.");
      return false;
    }
    if (this.app.vault.getAbstractFileByPath(targetPath)) {
      new Notice("Un fichier porte déjà ce nom dans ce dossier.");
      return false;
    }

    const tasksBeforeMove = this.parseBoardTasks(await this.readFile(file), path);
    try {
      await this.app.fileManager.renameFile(file, targetPath);
    } catch (error) {
      console.error("Tâches Kanban: impossible de déplacer le tableau", error);
      new Notice("Impossible de déplacer le tableau.");
      return false;
    }

    const movedFile = this.getMarkdownFile(targetPath);
    const tasksAfterMove = movedFile ? this.parseBoardTasks(await this.readFile(movedFile), targetPath) : [];
    let storeChanged = false;
    for (let index = 0; index < Math.min(tasksBeforeMove.length, tasksAfterMove.length); index += 1) {
      const oldKey = tasksBeforeMove[index].key;
      const newKey = tasksAfterMove[index].key;
      if (oldKey === newKey) continue;
      if (Object.prototype.hasOwnProperty.call(this.data.timers, oldKey)) {
        this.data.timers[newKey] = this.data.timers[oldKey];
        delete this.data.timers[oldKey];
        storeChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(this.data.forcedStarts, oldKey)) {
        this.data.forcedStarts[newKey] = this.data.forcedStarts[oldKey];
        delete this.data.forcedStarts[oldKey];
        storeChanged = true;
      }
    }
    if (storeChanged) this.queueSave(true);
    this.boardTasks.delete(path);
    this.boardTasks.delete(targetPath);
    this.refreshViews(path);
    this.refreshViews(targetPath);
    new Notice(`Tableau déplacé vers « ${folderPath || "la racine du coffre"} »`);
    return true;
  }
};
