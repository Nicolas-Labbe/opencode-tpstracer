/**
 * Small dependency-free controls for the TPSTracer dashboard.
 *
 * The selection popover is a labelled button plus a listbox with
 * aria-activedescendant, bounded scrolling and explicit keyboard/dismissal
 * behavior. The mode control is a two-button segmented group with pressed
 * state, and the live preference is a labelled native checkbox exposed as a
 * switch. No portal or external UI dependency is used.
 */

import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js";
import type { Language, ViewMode } from "./definition.js";
import { normalizeLanguage, normalizeViewMode } from "./definition.js";
import { t } from "./i18n.js";
import {
  listboxKeyboard,
  listboxOptionID,
  nextListboxScrollTop,
  reconcileListboxActive,
  type ListboxOption,
} from "./dashboard.js";

export interface SelectionPopoverProps {
  id: string;
  /** Accessible name for the trigger and listbox. */
  label: string;
  value: string;
  options: readonly ListboxOption[];
  onChange: (value: string) => void;
  lang?: Language;
  align?: "start" | "end";
  class?: string;
  disabled?: boolean;
  emptyLabel?: string;
}

/** Reusable accessible selection popover replacing native open dropdowns. */
export function SelectionPopover(props: SelectionPopoverProps) {
  const l = () => normalizeLanguage(props.lang);
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal<string | null>(null);
  let rootRef: HTMLDivElement | undefined;
  let triggerRef: HTMLButtonElement | undefined;
  let listRef: HTMLDivElement | undefined;
  let disposed = false;

  const options = createMemo<readonly ListboxOption[]>(() => props.options);
  const selected = createMemo(() => options().find((option) => option.value === props.value) ?? null);
  const listId = () => `${props.id}-listbox`;
  const triggerId = () => `${props.id}-trigger`;
  const activeID = () => {
    const value = active();
    return value === null ? undefined : listboxOptionID(props.id, value, options());
  };
  const triggerLabel = () => {
    const current = selected();
    return current ? `${props.label}: ${current.label}` : props.label;
  };
  const visibleValue = () => selected()?.label ?? props.emptyLabel ?? t(l(), "menu.empty");

  const openMenu = () => {
    setActive(reconcileListboxActive(options(), null, props.value));
    setOpen(true);
    queueMicrotask(() => listRef?.focus());
  };

  const closeMenu = (focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) triggerRef?.focus();
  };

  onCleanup(() => {
    disposed = true;
  });

  // Keep the active option inside the bounded list without scrolling the
  // page or panel. getBoundingClientRect plus list.scrollTop is intentionally
  // contained; scrollIntoView is avoided because it can move ancestors.
  const scrollActiveIntoView = (id: string) => {
    if (disposed || !open()) return;
    const list = listRef;
    if (!list || list.clientHeight <= 0) return;
    const option = list.ownerDocument.getElementById(id);
    if (!option || !list.contains(option)) return;
    const listRect = list.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    const next = nextListboxScrollTop({
      optionTop: optionRect.top,
      optionBottom: optionRect.bottom,
      listTop: listRect.top,
      listBottom: listRect.bottom,
      scrollTop: list.scrollTop,
    });
    if (next !== list.scrollTop) list.scrollTop = next;
  };

  // Reconcile the active option when the inventory changes while open. A
  // removed option is never committed: the active value moves to the current
  // selection or the first enabled option.
  createEffect(() => {
    if (!open()) return;
    const next = reconcileListboxActive(options(), active(), props.value);
    if (next !== active()) setActive(next);
  });

  // Open, arrows, Home/End, typeahead and option reconciliation all change
  // the active id; this effect keeps it visible in the list's own viewport.
  createEffect(() => {
    if (!open()) return;
    const id = activeID();
    if (!id) return;
    queueMicrotask(() => {
      if (activeID() === id) scrollActiveIntoView(id);
    });
  });

  // Outside-pointer dismissal with listener cleanup on close/disposal.
  createEffect(() => {
    if (!open()) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef?.contains(target)) return;
      closeMenu(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true));
  });

  const commit = (value: string) => {
    if (value !== props.value) props.onChange(value);
    closeMenu(true);
  };

  const onListKeyDown = (event: KeyboardEvent) => {
    const result = listboxKeyboard(event.key, options(), active());
    if (result.handled) event.preventDefault();
    if (result.activeValue !== active()) setActive(result.activeValue);
    if (result.commitValue !== null) {
      commit(result.commitValue);
    } else if (result.close) {
      closeMenu(result.focusTrigger);
    }
  };

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (open()) return;
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      openMenu();
    }
  };

  return (
    <div ref={(el) => (rootRef = el)} class={`tps-menu ${props.class ?? ""}`.trim()}>
      <button
        ref={(el) => (triggerRef = el)}
        id={triggerId()}
        type="button"
        class="tps-menu-trigger"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={open() ? listId() : undefined}
        aria-label={triggerLabel()}
        title={triggerLabel()}
        disabled={props.disabled}
        onClick={() => (open() ? closeMenu(true) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span class="tps-menu-value" dir={selected()?.dir}>
          {selected()?.dir ? visibleValue() : <bdi dir="auto">{visibleValue()}</bdi>}
        </span>
        <span class="tps-menu-chevron" aria-hidden="true">
          <svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
            <path
              d="M1 1l4 4 4-4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
      </button>
      <Show when={open()}>
        <div class="tps-menu-pop" data-align={props.align ?? "start"}>
          <div
            ref={(el) => (listRef = el)}
            id={listId()}
            class="tps-menu-list"
            role="listbox"
            tabindex="-1"
            aria-label={props.label}
            aria-activedescendant={activeID()}
            onKeyDown={onListKeyDown}
          >
            <For each={options()}>
              {(option, index) => (
                <div
                  id={`${props.id}-option-${index()}`}
                  class="tps-menu-option"
                  role="option"
                  aria-selected={option.value === props.value}
                  aria-disabled={option.disabled ? "true" : undefined}
                  data-active={option.value === active() ? "true" : "false"}
                  data-disabled={option.disabled ? "true" : undefined}
                  title={option.detail ? `${option.label} — ${option.detail}` : option.label}
                  onPointerEnter={() => {
                    if (!option.disabled) setActive(option.value);
                  }}
                  onClick={() => {
                    if (!option.disabled) commit(option.value);
                  }}
                >
                  <span class="tps-menu-option-label" dir={option.dir}>
                    {option.dir ? option.label : <bdi dir="auto">{option.label}</bdi>}
                  </span>
                  <Show when={option.detail}>
                    <span class="tps-menu-option-detail">{option.detail}</span>
                  </Show>
                </div>
              )}
            </For>
            <Show when={options().length === 0}>
              <p class="tps-menu-empty">{props.emptyLabel ?? t(l(), "menu.empty")}</p>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

export function ViewModeControl(props: {
  value: ViewMode;
  onChange: (next: ViewMode) => void;
  lang?: Language;
}) {
  const l = () => normalizeLanguage(props.lang);
  const value = () => normalizeViewMode(props.value);
  return (
    <div class="tps-mode" role="group" aria-label={t(l(), "view.modeLabel")}>
      <button
        type="button"
        class="tps-mode-btn"
        aria-pressed={value() === "simple"}
        onClick={() => {
          if (value() !== "simple") props.onChange("simple");
        }}
      >
        {t(l(), "view.simple")}
      </button>
      <button
        type="button"
        class="tps-mode-btn"
        aria-pressed={value() === "detailed"}
        onClick={() => {
          if (value() !== "detailed") props.onChange("detailed");
        }}
      >
        {t(l(), "view.detailed")}
      </button>
    </div>
  );
}

export function LiveEstimateSwitch(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  lang?: Language;
}) {
  const l = () => normalizeLanguage(props.lang);
  return (
    <label class="tps-switch">
      <input
        class="tps-switch-input"
        type="checkbox"
        role="switch"
        checked={props.checked}
        aria-checked={props.checked ? "true" : "false"}
        aria-label={t(l(), "live.toggle")}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span class="tps-switch-track" aria-hidden="true">
        <span class="tps-switch-thumb" />
      </span>
      <span class="tps-switch-text">{t(l(), "live.toggle")}</span>
    </label>
  );
}
