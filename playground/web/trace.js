/* Recorded execution navigation. No code executes when moving the cursor. */
(function (root) {
  'use strict';
  class SproutTrace {
    constructor() { this.clear(); this.breakpoints = new Set(); }
    clear() { this.events = []; this.cursor = -1; this.source = ''; this.file = ''; this.stale = false; this.truncated = false; }
    record(events, source, file, truncated = false) {
      this.events = events.slice(); this.source = source; this.file = file;
      this.cursor = this.events.length ? 0 : -1; this.stale = false; this.truncated = truncated;
      return this.current();
    }
    append(events) {
      this.events.push(...events);
      if (this.cursor < 0 && this.events.length) this.cursor = 0;
    }
    current() { return this.events[this.cursor] || null; }
    move(delta) {
      if (!this.events.length || this.stale) return null;
      this.cursor = Math.max(0, Math.min(this.events.length - 1, this.cursor + delta));
      return this.current();
    }
    seek(index) {
      if (!this.events.length || this.stale) return null;
      this.cursor = Math.max(0, Math.min(this.events.length - 1, Math.floor(index)));
      return this.current();
    }
    toggleBreakpoint(line) {
      if (!Number.isInteger(line) || line < 1) return;
      if (this.breakpoints.has(line)) this.breakpoints.delete(line); else this.breakpoints.add(line);
    }
    nextBreakpoint() {
      if (this.stale) return null;
      const index = this.events.findIndex((event, index) => index > this.cursor && this.breakpoints.has(event.line));
      return index < 0 ? null : this.seek(index);
    }
    invalidate(source, file) { this.stale = !!this.file && (source !== this.source || file !== this.file); return this.stale; }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = SproutTrace;
  else root.SproutTrace = SproutTrace;
})(typeof globalThis !== 'undefined' ? globalThis : this);
