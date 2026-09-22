import type { Assessment, ProviderExport } from "@scubaanywhere/core";

/**
 * Everything the app knows during a session, held in one place so it can be
 * thrown away in one place.
 *
 * Nothing here is written to disk, to browser storage, or to a server. It lives
 * in this tab's memory until the operator wipes it, closes the tab, or reloads.
 */
export interface SessionState {
  settings?: ProviderExport;
  assessment?: Assessment;
  /** What each collector did, for the run log shown next to the report. */
  log: LogEntry[];
  signedInAs?: string;
  tenant?: { id: string; displayName: string };
}

export interface LogEntry {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

type Listener = (state: SessionState) => void;

export class Session {
  private state: SessionState = { log: [] };
  private readonly listeners = new Set<Listener>();

  get current(): Readonly<SessionState> {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  update(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  log(level: LogEntry["level"], message: string): void {
    this.state = { ...this.state, log: [...this.state.log, { at: new Date().toISOString(), level, message }] };
    this.emit();
  }

  /** Does this session hold something the operator would not want to lose or leak? */
  get holdsData(): boolean {
    return Boolean(this.state.settings ?? this.state.assessment);
  }

  /** Drop everything. The only way back is to collect again. */
  wipe(): void {
    this.state = { log: [] };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

/**
 * Make persistence a loud failure rather than a quiet one.
 *
 * The promise this tool makes is that a tenant's configuration does not outlive
 * the session. A dependency that casually caches to localStorage would break
 * that without anyone noticing, so the storage APIs are replaced with ones that
 * throw. Call once at startup, before anything else runs.
 */
export function blockPersistentStorage(): void {
  // Replace the method on the prototype, not on localStorage itself: a Storage
  // object treats its own properties as stored items, so defining one there
  // would create the very entry this is meant to prevent.
  try {
    Object.defineProperty(Storage.prototype, "setItem", {
      value: () => {
        throw new Error("Web Storage is disabled: SCuBAAnywhere keeps assessment data in memory only.");
      },
      configurable: true,
      enumerable: false,
      writable: true,
    });
  } catch {
    // A browser that will not let us redefine it still gets the CSP and the
    // memory-only token cache; nothing in this app writes to storage itself.
  }
}

/** Warn before a reload or a close would throw away a report. */
export function warnBeforeLosingData(session: Session): void {
  window.addEventListener("beforeunload", (event) => {
    if (!session.holdsData) return;
    event.preventDefault();
    event.returnValue = "";
  });
}
