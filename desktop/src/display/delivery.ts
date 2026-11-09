/** One frame owned by the consumer and one replaceable newest pending frame. */
export class LatestDelivery<T> {
  private inFlight = false;
  private pending?: T;
  dropped = 0;
  constructor(private send: (value: T) => void) {}
  offer(value: T) {
    if (this.inFlight) {
      if (this.pending !== undefined) this.dropped++;
      this.pending = value;
    } else {
      this.inFlight = true;
      this.send(value);
    }
  }
  consumed() {
    this.inFlight = false;
    if (this.pending !== undefined) {
      const next = this.pending;
      this.pending = undefined;
      this.offer(next);
    }
  }
  get queued() {
    return Number(this.inFlight) + Number(this.pending !== undefined);
  }
}
