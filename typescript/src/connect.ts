/**
 * CODA Connect for EMR web pages (ADR-013). Adds "Search with CODA" for highlighted text, opens
 * the CODA picker, and returns the clinician's selection. No dependencies; works as a plain ES
 * module (served by CODA at /connect.js) or bundled from @coda-terminology/client/connect.
 *
 * Security: messages go only to the CODA origin and are accepted only from the picker window
 * this page opened. CODA itself only posts results to origins registered for the app.
 */

export interface ConnectSelection {
  system: string;
  systemKey: string;
  version: string;
  code: string;
  display: string;
  coding: { system: string; version: string; code: string; display: string };
  cwe: string;
}

export interface ConnectResult {
  sessionId: string;
  appId: string;
  status: 'completed';
  purpose: string;
  encounterRef: string | null;
  /** The EMR's own opaque patient token, echoed back (never an identifier). */
  patientRef?: string | null;
  completedAt: string;
  completedBy: string;
  selections: ConnectSelection[];
  /** The text the clinician started from (browser channel only; never sent by webhook). */
  originalText: string | null;
}

export interface PickOptions {
  text: string;
  systems?: string[];
  valueSet?: string;
  maxSelections?: number;
  purpose?: string;
  /** Opaque encounter token generated and mapped by the EMR (never an identifier). */
  encounterRef?: string;
  /** Opaque patient token generated and mapped by the EMR, e.g. a random UUID (never an MRN or a hash of one). */
  patientRef?: string;
}

export interface CodaConnectOptions {
  /** CODA web origin, e.g. https://coda.hospital.ng */
  codaUrl: string;
  /** The Connect app id registered by the CODA administrator. */
  appId: string;
  /** Defaults applied to every pick (overridable per call). */
  defaults?: Omit<PickOptions, 'text'>;
  /** Popup size (default 720 x 760). */
  popup?: { width: number; height: number };
  /**
   * 'popup' (default): a separate window, no CODA server configuration needed.
   * 'modal': an in-page overlay (iframe). Immune to pop-up blockers and works in kiosk browsers and
   * webviews; CODA-Web must allow the EMR origin in its frame-ancestors policy.
   */
  display?: 'popup' | 'modal';
  /** Give up if the picker does not answer (default 15 minutes). */
  timeoutMs?: number;
}

export type InsertFormat = 'display-code' | 'display' | 'code' | 'fhir-coding' | 'cwe' | ((s: ConnectSelection) => string);

/** Thrown (rejected) when the clinician cancels or closes the picker. */
export class CodaConnectCancelled extends Error {
  constructor(message = 'The CODA picker was closed without a selection.') {
    super(message);
    this.name = 'CodaConnectCancelled';
  }
}

type Editable = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export class CodaConnect {
  private readonly codaOrigin: string;
  private active: { close: () => void } | null = null;

  constructor(private readonly options: CodaConnectOptions) {
    this.codaOrigin = new URL(options.codaUrl).origin;
  }

  /** Opens the CODA picker for `text` and resolves with the selection. Must be called from a user gesture. */
  pick(pick: PickOptions): Promise<ConnectResult> {
    this.active?.close();
    const url = `${this.codaOrigin}/connect?app=${encodeURIComponent(this.options.appId)}`;
    const surface = this.options.display === 'modal' ? openModal(url) : openPopup(url, this.options.popup);
    if (!surface) return Promise.reject(new Error('The browser blocked the CODA window. Allow pop-ups for this site, or use display: "modal".'));
    this.active = surface;

    const launch = { type: 'coda:launch', ...this.options.defaults, ...pick, text: pick.text.slice(0, 2000) };
    return new Promise<ConnectResult>((resolve, reject) => {
      let launched = false;
      const finish = () => {
        window.removeEventListener('message', onMessage);
        clearInterval(closedPoll);
        clearTimeout(timer);
        surface.close();
        if (this.active === surface) this.active = null;
      };
      const onMessage = (event: MessageEvent) => {
        // Only the picker we opened, on the CODA origin.
        if (event.origin !== this.codaOrigin || event.source !== surface.window()) return;
        const data = event.data as { type?: string; result?: Omit<ConnectResult, 'originalText'>; originalText?: string | null } | null;
        if (data?.type === 'coda:ready' && !launched) {
          launched = true;
          surface.window()?.postMessage(launch, this.codaOrigin);
        } else if (data?.type === 'coda:selection' && data.result) {
          finish();
          resolve({ ...data.result, originalText: data.originalText ?? null });
        } else if (data?.type === 'coda:cancelled') {
          finish();
          reject(new CodaConnectCancelled('The clinician cancelled.'));
        }
      };
      const closedPoll = setInterval(() => {
        if (surface.closed()) {
          finish();
          reject(new CodaConnectCancelled());
        }
      }, 500);
      const timer = setTimeout(() => {
        finish();
        reject(new CodaConnectCancelled('The CODA picker timed out.'));
      }, this.options.timeoutMs ?? 15 * 60_000);
      window.addEventListener('message', onMessage);
    });
  }

  /**
   * Right-click on selected text inside `scope` shows "Search with CODA"; Ctrl+Shift+K does the same.
   * `onSelect` receives the result and the editable field the text came from (if any).
   * Returns a function that removes the integration.
   */
  attachContextMenu(scope: HTMLElement | Document, handlers: {
    onSelect: (result: ConnectResult, target: Editable | null) => void;
    onError?: (error: unknown) => void;
    label?: string;
    shortcut?: boolean;
    context?: () => Omit<PickOptions, 'text'>;
  }): () => void {
    const label = handlers.label ?? 'Search with CODA';
    let menu: HTMLElement | null = null;
    const close = () => { menu?.remove(); menu = null; };

    const run = (text: string, target: Editable | null) => {
      close();
      this.pick({ text, ...handlers.context?.() })
        .then((r) => handlers.onSelect(r, target))
        .catch((e) => { if (!(e instanceof CodaConnectCancelled)) handlers.onError?.(e); });
    };

    const onContextMenu = (event: Event) => {
      const e = event as MouseEvent;
      const { text, target } = selectionIn(scope, e.target);
      if (!text) return;
      e.preventDefault();
      close();
      menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.className = 'coda-connect-menu';
      Object.assign(menu.style, {
        position: 'fixed', left: `${e.clientX}px`, top: `${e.clientY}px`, zIndex: '2147483647', background: '#fff', color: '#111',
        border: '1px solid #c8ccd2', borderRadius: '6px', boxShadow: '0 6px 18px rgba(0,0,0,.18)', padding: '4px', font: '14px system-ui, sans-serif',
      });
      const item = (text2: string, action: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.textContent = text2;
        Object.assign(b.style, { display: 'block', width: '100%', textAlign: 'left', border: '0', background: 'none', padding: '6px 12px', cursor: 'pointer', font: 'inherit' });
        b.addEventListener('click', action);
        menu!.appendChild(b);
        return b;
      };
      const first = item(`◆ ${label}`, () => run(text, target));
      item('Copy', () => { void navigator.clipboard?.writeText(text); close(); });
      document.body.appendChild(menu);
      first.focus();
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (handlers.shortcut !== false && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'k') {
        const { text, target } = selectionIn(scope, document.activeElement);
        if (text) {
          event.preventDefault();
          run(text, target);
        }
      }
    };
    const onDown = (event: MouseEvent) => { if (menu && !menu.contains(event.target as Node)) close(); };

    scope.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      close();
      scope.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }

  /** Inserts a selection into an input, textarea or contenteditable field at the caret (replacing selected text). */
  insertInto(target: Editable | null, selection: ConnectSelection | undefined, format: InsertFormat = 'display-code'): boolean {
    if (!target || !selection) return false;
    const value = CodaConnect.format(selection, format);
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      target.setRangeText(value, start, end, 'end');
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    if (target.isContentEditable) {
      target.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && target.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(value));
        sel.collapseToEnd();
      } else {
        target.append(value);
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    return false;
  }

  static format(s: ConnectSelection, format: InsertFormat): string {
    if (typeof format === 'function') return format(s);
    switch (format) {
      case 'display': return s.display;
      case 'code': return s.code;
      case 'fhir-coding': return JSON.stringify(s.coding);
      case 'cwe': return s.cwe;
      default: return `${s.display} (${s.code})`;
    }
  }
}

/** The highlighted text within `scope`, and the editable field it belongs to. */
function selectionIn(scope: HTMLElement | Document, origin: EventTarget | Element | null): { text: string; target: Editable | null } {
  const el = origin instanceof Element ? origin : null;
  const root = scope instanceof Document ? scope.documentElement : scope;
  if (el && !root.contains(el)) return { text: '', target: null };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const text = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0).trim();
    return { text, target: el };
  }
  const text = (window.getSelection()?.toString() ?? '').trim();
  const editable = el?.closest('[contenteditable=""], [contenteditable="true"]') as HTMLElement | null;
  return { text, target: editable };
}

interface Surface {
  window: () => Window | null;
  closed: () => boolean;
  close: () => void;
}

function openPopup(url: string, size?: { width: number; height: number }): Surface | null {
  const { width, height } = size ?? { width: 720, height: 760 };
  const left = Math.max(0, (window.screenX ?? 0) + ((window.outerWidth ?? width) - width) / 2);
  const top = Math.max(0, (window.screenY ?? 0) + ((window.outerHeight ?? height) - height) / 2);
  const popup = window.open(url, 'coda-connect', `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
  if (!popup) return null;
  return { window: () => popup, closed: () => popup.closed, close: () => { if (!popup.closed) popup.close(); } };
}

/** An accessible modal dialog hosting the picker in an iframe; Escape or the close button cancels. */
function openModal(url: string): Surface {
  let isClosed = false;
  const previousFocus = document.activeElement as HTMLElement | null;
  const backdrop = document.createElement('div');
  Object.assign(backdrop.style, {
    position: 'fixed', inset: '0', zIndex: '2147483646', background: 'rgba(15, 23, 42, 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  });
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'CODA coding');
  Object.assign(dialog.style, {
    position: 'relative', width: 'min(760px, 96vw)', height: 'min(800px, 92vh)', background: '#fff', borderRadius: '10px', overflow: 'hidden',
    boxShadow: '0 20px 50px rgba(0,0,0,.35)',
  });
  const frame = document.createElement('iframe');
  frame.src = url;
  frame.title = 'CODA coding';
  frame.allow = 'clipboard-write';
  Object.assign(frame.style, { width: '100%', height: '100%', border: '0' });
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close CODA');
  Object.assign(close.style, {
    position: 'absolute', top: '6px', right: '8px', width: '32px', height: '32px', border: '0', borderRadius: '16px', background: 'rgba(0,0,0,.06)',
    font: '20px/1 system-ui, sans-serif', cursor: 'pointer',
  });
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') surface.close(); };
  const surface: Surface = {
    window: () => frame.contentWindow,
    closed: () => isClosed,
    close: () => {
      if (isClosed) return;
      isClosed = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      previousFocus?.focus?.();
    },
  };
  close.addEventListener('click', () => surface.close());
  document.addEventListener('keydown', onKey);
  dialog.append(frame, close);
  backdrop.append(dialog);
  document.body.append(backdrop);
  frame.focus();
  return surface;
}
