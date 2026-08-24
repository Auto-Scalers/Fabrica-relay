import type { PendingConn } from "../shared/types";

export interface StoredHostState {
  relayHostId: string;
  assignmentEpoch: number;
  generation: number;
  controlResumeSecret: string;
  leaseExpiresAt: number;
  appVersion: string;
}

export interface StoredInvite {
  token: string;
  attempts: number;
  createdAt: number;
}

export interface StoredCredential {
  deviceId: string;
  pubKey: string;
  createdAt: number;
  version: number;
}

export class CellStore {
  constructor(private ctx: DurableObjectState) {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS host_state (
        host_id TEXT PRIMARY KEY,
        assignmentEpoch INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        controlResumeSecret TEXT NOT NULL,
        leaseExpiresAt INTEGER NOT NULL,
        appVersion TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        host_id TEXT NOT NULL,
        token TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (host_id, token)
      );
      CREATE TABLE IF NOT EXISTS device_credentials (
        host_id TEXT NOT NULL,
        deviceId TEXT NOT NULL,
        pubKey TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (host_id, deviceId)
      );
      CREATE TABLE IF NOT EXISTS pending_conns (
        host_id TEXT NOT NULL,
        connId TEXT NOT NULL,
        connTicket TEXT NOT NULL,
        PRIMARY KEY (host_id, connId)
      );
    `);

    // Migrate legacy schema (single-host era) — columns created before host_id existed.
    const alterStmts = [
      "ALTER TABLE host_state ADD COLUMN host_id TEXT",
      "ALTER TABLE invites ADD COLUMN host_id TEXT",
      "ALTER TABLE device_credentials ADD COLUMN host_id TEXT",
      "ALTER TABLE pending_conns ADD COLUMN host_id TEXT",
    ];
    for (const stmt of alterStmts) {
      try {
        this.ctx.storage.sql.exec(stmt);
      } catch {
        // column already exists
      }
    }
    // Backfill legacy host_state rows (old PK was relayHostId, no host_id column).
    try {
      this.ctx.storage.sql.exec(
        "UPDATE host_state SET host_id = relayHostId WHERE host_id IS NULL",
      );
    } catch {
      // fresh schema: no relayHostId column
    }
  }

  // --- host state (one row per host) ---

  getAllHostStates(): StoredHostState[] {
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM host_state")
      .toArray() as unknown as StoredHostState[];
    for (const r of rows) {
      (r as unknown as { relayHostId: string }).relayHostId = (r as unknown as { host_id: string }).host_id;
    }
    return rows;
  }

  getHostState(hostId: string): StoredHostState | null {
    const row = this.ctx.storage.sql
      .exec("SELECT * FROM host_state WHERE host_id = ?", hostId)
      .one() as unknown as StoredHostState | null;
    if (row) {
      (row as unknown as { relayHostId: string }).relayHostId = (row as unknown as { host_id: string }).host_id;
    }
    return row ?? null;
  }

  putHostState(hostId: string, s: StoredHostState): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO host_state (host_id, assignmentEpoch, generation, controlResumeSecret, leaseExpiresAt, appVersion) VALUES (?, ?, ?, ?, ?, ?)",
      hostId,
      s.assignmentEpoch,
      s.generation,
      s.controlResumeSecret,
      s.leaseExpiresAt,
      s.appVersion,
    );
  }

  clearHostState(hostId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM host_state WHERE host_id = ?", hostId);
  }

  // --- invites ---

  getInvites(hostId: string): Map<string, StoredInvite> {
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM invites WHERE host_id = ?", hostId)
      .toArray() as unknown as StoredInvite[];
    const map = new Map<string, StoredInvite>();
    for (const r of rows) {
      map.set(r.token, r);
    }
    return map;
  }

  putInvite(hostId: string, invite: StoredInvite): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO invites (host_id, token, attempts, createdAt) VALUES (?, ?, ?, ?)",
      hostId,
      invite.token,
      invite.attempts,
      invite.createdAt as number,
    );
  }

  deleteInvite(hostId: string, token: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM invites WHERE host_id = ? AND token = ?",
      hostId,
      token,
    );
  }

  // --- device credentials ---

  getCredentials(hostId: string): Map<string, StoredCredential> {
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM device_credentials WHERE host_id = ?", hostId)
      .toArray() as unknown as StoredCredential[];
    const map = new Map<string, StoredCredential>();
    for (const r of rows) {
      map.set(r.deviceId, r);
    }
    return map;
  }

  putCredential(hostId: string, cred: StoredCredential): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO device_credentials (host_id, deviceId, pubKey, createdAt, version) VALUES (?, ?, ?, ?, ?)",
      hostId,
      cred.deviceId,
      cred.pubKey,
      cred.createdAt as number,
      cred.version as number,
    );
  }

  deleteCredential(hostId: string, deviceId: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM device_credentials WHERE host_id = ? AND deviceId = ?",
      hostId,
      deviceId,
    );
  }

  // --- pending connections ---

  getPendingConns(hostId: string): PendingConn[] {
    // Explicit columns only — SELECT * would leak the internal host_id column
    // into wire-facing PendingConn objects (client schema is .strict())
    return this.ctx.storage.sql
      .exec("SELECT connId, connTicket FROM pending_conns WHERE host_id = ?", hostId)
      .toArray() as unknown as PendingConn[];
  }

  putPendingConn(hostId: string, conn: PendingConn): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO pending_conns (host_id, connId, connTicket) VALUES (?, ?, ?)",
      hostId,
      conn.connId,
      conn.connTicket,
    );
  }

  deletePendingConn(hostId: string, connId: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM pending_conns WHERE host_id = ? AND connId = ?",
      hostId,
      connId,
    );
  }

  clearPendingConns(hostId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM pending_conns WHERE host_id = ?", hostId);
  }
}
