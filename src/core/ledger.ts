// Hash-chained append-only ticket ledger (source of truth, independent of git).
// prev_ticket_hash = sha256(canonicalJson(previous ticket)); genesis = sha256("genesis").
import { appendLine, readJsonl, canonicalJson, sha256, todayStamp, paths } from "../util.ts";
import type { Ticket } from "../types.ts";

export const GENESIS = sha256("genesis");

export class Ledger {
  private file: string;
  private tickets: Ticket[];
  private lastHash: string;
  private seqByDay: Map<string, number> = new Map();

  constructor(ledgerHome: string) {
    this.file = paths(ledgerHome).tickets;
    this.tickets = readJsonl<Ticket>(this.file);
    this.lastHash = this.tickets.length
      ? sha256(canonicalJson(this.tickets[this.tickets.length - 1]))
      : GENESIS;
    for (const t of this.tickets) {
      const day = t.change_id.split("-")[1];
      const seq = parseInt(t.change_id.split("-")[2], 10);
      if (!Number.isNaN(seq)) {
        this.seqByDay.set(day, Math.max(this.seqByDay.get(day) || 0, seq));
      }
    }
  }

  // allocate next chg-<YYYYMMDD>-<seq> without collision (monotonic per day)
  nextChangeId(): string {
    const day = todayStamp();
    const seq = (this.seqByDay.get(day) || 0) + 1;
    this.seqByDay.set(day, seq);
    return `chg-${day}-${String(seq).padStart(3, "0")}`;
  }

  hasChangeId(id: string): boolean {
    return this.tickets.some((t) => t.change_id === id);
  }

  // append a ticket, sealing the hash chain link. Mutates prev_ticket_hash.
  append(ticket: Ticket): Ticket {
    ticket.prev_ticket_hash = this.lastHash;
    appendLine(this.file, ticket);
    this.tickets.push(ticket);
    this.lastHash = sha256(canonicalJson(ticket));
    return ticket;
  }

  all(): Ticket[] {
    return this.tickets.slice();
  }

  find(changeId: string): Ticket | undefined {
    return this.tickets.find((t) => t.change_id === changeId);
  }

  // Recompute the chain; returns first broken index or -1 if intact.
  verify(): { ok: boolean; brokenIndex: number; detail: string } {
    let prev = GENESIS;
    const all = readJsonl<Ticket>(this.file);
    for (let i = 0; i < all.length; i++) {
      if (all[i].prev_ticket_hash !== prev) {
        return {
          ok: false,
          brokenIndex: i,
          detail: `ticket[${i}] ${all[i].change_id}: prev_ticket_hash=${all[i].prev_ticket_hash} expected ${prev}`,
        };
      }
      prev = sha256(canonicalJson(all[i]));
    }
    return { ok: true, brokenIndex: -1, detail: `chain intact over ${all.length} tickets` };
  }
}
