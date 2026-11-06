// A typed publish/subscribe channel (Observer). Event names and payloads are checked at compile time
// through the EventMap type parameter, e.g. EventBus<{ feed: { x: number } }>.

export type Listener<P> = (payload: P) => void;
export type Unsubscribe = () => void;

export class EventBus<EventMap extends object> {
  private readonly listeners = new Map<keyof EventMap, Set<Listener<never>>>();

  on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) (listener as Listener<EventMap[K]>)(payload);
  }
}
