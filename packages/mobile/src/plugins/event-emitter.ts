/*
FNXC:MobileShell 2026-10-07-19:30:
Mobile plugin managers run inside the packaged Capacitor WebView, where Node builtins such as `node:events` do not exist.
This is the browser-safe subset of EventEmitter the managers use: synchronous delivery in registration order, a snapshot per emit, and `emit` reporting whether any listener ran.
*/

type Listener = (...args: any[]) => void;

export class BrowserEventEmitter {
  private readonly listenersByEvent = new Map<string | symbol, Listener[]>();

  on(event: string | symbol, listener: Listener): this {
    const listeners = this.listenersByEvent.get(event) ?? [];
    listeners.push(listener);
    this.listenersByEvent.set(event, listeners);
    return this;
  }

  off(event: string | symbol, listener: Listener): this {
    const listeners = this.listenersByEvent.get(event);
    if (!listeners) return this;
    const index = listeners.lastIndexOf(listener);
    if (index !== -1) listeners.splice(index, 1);
    if (listeners.length === 0) this.listenersByEvent.delete(event);
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const listeners = this.listenersByEvent.get(event);
    if (!listeners || listeners.length === 0) return false;
    for (const listener of [...listeners]) listener(...args);
    return true;
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.listenersByEvent.clear();
    else this.listenersByEvent.delete(event);
    return this;
  }

  listenerCount(event: string | symbol): number {
    return this.listenersByEvent.get(event)?.length ?? 0;
  }
}
