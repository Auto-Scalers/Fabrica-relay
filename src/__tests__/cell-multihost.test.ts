import { describe, it, expect } from "vitest";
import { CellStore } from "../cell/store";
import type { PendingConn } from "../shared/types";

// Minimal in-memory SQLite mock supporting exactly the statements CellStore issues.
// This lets us assert per-host isolation without a Workers runtime.

type Row = Record<string, unknown>;

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

class MockSql {
  tables = new Map<string, { columns: string[]; pk: string[]; rows: Row[] }>();

  exec(sql: string, ...params: unknown[]) {
    const s = sql.replace(/\s+/g, " ").trim();

    const create = s.match(/^CREATE TABLE IF NOT EXISTS (\w+)\s*\((.*)\)$/i);
    if (create) {
      const name = create[1];
      const t = this.tables.get(name) ?? { columns: [], pk: [], rows: [] };
      const cols: string[] = [];
      const pk: string[] = [];
      for (const seg of splitTop(create[2])) {
        const segTrim = seg.trim();
        const pkMatch = segTrim.match(/^PRIMARY KEY\s*\((.*)\)$/i);
        if (pkMatch) {
          pk.push(...pkMatch[1].split(",").map((c) => c.trim()));
        } else {
          cols.push(segTrim.split(/\s+/)[0]);
        }
      }
      t.columns = Array.from(new Set([...t.columns, ...cols]));
      if (pk.length) t.pk = pk;
      this.tables.set(name, t);
      return emptyResult();
    }

    const alter = s.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
    if (alter) {
      const t = this.tables.get(alter[1]);
      if (t && !t.columns.includes(alter[2])) t.columns.push(alter[2]);
      return emptyResult();
    }

    const update = s.match(/^UPDATE (\w+) SET (\w+) = (\w+) WHERE (\w+) IS NULL$/i);
    if (update) {
      const t = this.tables.get(update[1]);
      if (t) {
        for (const r of t.rows) {
          if (r[update[4]] === null || r[update[4]] === undefined) r[update[2]] = r[update[3]];
        }
      }
      return emptyResult();
    }

    const select = s.match(/^SELECT (.+?) FROM (\w+)(?:\s+WHERE (\w+) = \?)?$/i);
    if (select) {
      const t = this.tables.get(select[2]) ?? { columns: [], pk: [], rows: [] };
      let rows = t.rows;
      if (select[3]) rows = rows.filter((r) => r[select[3]] === params[0]);
      const cols = select[1].trim();
      if (cols !== "*") {
        const names = cols.split(",").map((c) => c.trim());
        rows = rows.map((r) => Object.fromEntries(names.map((n) => [n, r[n]])));
      }
      return result(rows);
    }

    const insert = s.match(
      /^INSERT OR REPLACE INTO (\w+)\s*\((.*)\)\s*VALUES\s*\((.*)\)$/i,
    );
    if (insert) {
      const name = insert[1];
      const cols = insert[2].split(",").map((c) => c.trim());
      const t = this.tables.get(name) ?? { columns: cols, pk: [], rows: [] };
      const vals = insert[3].split(",").map((c) => c.trim());
      const row: Row = {};
      cols.forEach((c, i) => {
        row[c] = vals[i] === "?" ? params[i] : vals[i];
      });
      if (t.pk.length) {
        const idx = t.rows.findIndex((r) => t.pk.every((k) => r[k] === row[k]));
        if (idx >= 0) t.rows[idx] = row;
        else t.rows.push(row);
      } else {
        t.rows.push(row);
      }
      this.tables.set(name, t);
      return emptyResult();
    }

    const del = s.match(/^DELETE FROM (\w+)\s+WHERE (.+)$/i);
    if (del) {
      const t = this.tables.get(del[1]);
      if (t) {
        const cols = del[2].split(/\s+AND\s+/i).map((c) => c.trim().match(/^(\w+) = \?$/i)![1]);
        t.rows = t.rows.filter((r) => !(cols.every((col, i) => r[col] === params[i])));
      }
      return emptyResult();
    }

    return emptyResult();
  }
}

function result(rows: Row[]) {
  return {
    one: () => (rows.length ? rows[0] : null),
    toArray: () => rows,
  };
}

function emptyResult() {
  return { one: () => null, toArray: () => [] };
}

describe("CellStore multi-host isolation", () => {
  it("keeps host state, invites, credentials, and pending conns isolated per relayHostId", () => {
    const sql = new MockSql();
    const ctx = { storage: { sql } } as unknown as DurableObjectState;
    const store = new CellStore(ctx);

    store.putHostState("host-a", {
      relayHostId: "host-a",
      assignmentEpoch: 1,
      generation: 5,
      controlResumeSecret: "sec-a",
      leaseExpiresAt: 100,
      appVersion: "1.0",
    });
    store.putHostState("host-b", {
      relayHostId: "host-b",
      assignmentEpoch: 2,
      generation: 7,
      controlResumeSecret: "sec-b",
      leaseExpiresAt: 200,
      appVersion: "2.0",
    });

    const a = store.getHostState("host-a");
    const b = store.getHostState("host-b");
    expect(a?.relayHostId).toBe("host-a");
    expect(a?.generation).toBe(5);
    expect(b?.relayHostId).toBe("host-b");
    expect(b?.generation).toBe(7);

    store.putInvite("host-a", { token: "tok-a", attempts: 0, createdAt: 1 });
    store.putInvite("host-b", { token: "tok-b", attempts: 0, createdAt: 1 });
    expect(store.getInvites("host-a").has("tok-a")).toBe(true);
    expect(store.getInvites("host-a").has("tok-b")).toBe(false);
    expect(store.getInvites("host-b").has("tok-b")).toBe(true);

    store.putCredential("host-a", { deviceId: "d-a", pubKey: "k", createdAt: 1, version: 1 });
    store.putCredential("host-b", { deviceId: "d-a", pubKey: "k2", createdAt: 1, version: 1 });
    expect(store.getCredentials("host-a").get("d-a")?.pubKey).toBe("k");
    expect(store.getCredentials("host-b").get("d-a")?.pubKey).toBe("k2");
    store.deleteCredential("host-a", "d-a");
    expect(store.getCredentials("host-a").has("d-a")).toBe(false);
    expect(store.getCredentials("host-b").has("d-a")).toBe(true);

    store.putPendingConn("host-a", { connId: "c-a", connTicket: "t-a" } as PendingConn);
    store.putPendingConn("host-b", { connId: "c-a", connTicket: "t-b" } as PendingConn);
    expect(store.getPendingConns("host-a")[0].connTicket).toBe("t-a");
    expect(store.getPendingConns("host-b")[0].connTicket).toBe("t-b");
    store.deletePendingConn("host-a", "c-a");
    expect(store.getPendingConns("host-a").length).toBe(0);
    expect(store.getPendingConns("host-b").length).toBe(1);
  });
});
