import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function sqlValue(value: unknown): string | number | bigint | Uint8Array | null {
  return value === undefined ? null : value as string | number | bigint | Uint8Array | null;
}

export class SqlStatement {
  private values: unknown[] = [];
  private readonly db: SqlD1;
  readonly sql: string;
  constructor(db: SqlD1, sql: string) { this.db = db; this.sql = sql; }
  bind(...values: unknown[]) { this.values = values; return this; }
  async first<T>(): Promise<T | null> {
    return (this.db.sqlite.prepare(this.sql).get(...this.values.map(sqlValue)) as T | undefined) || null;
  }
  async run() {
    this.db.sqlite.prepare(this.sql).run(...this.values.map(sqlValue));
    return { success: true };
  }
  async all<T>() {
    return { results: this.db.sqlite.prepare(this.sql).all(...this.values.map(sqlValue)) as T[] };
  }
}

export class SqlD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  constructor() {
    this.sqlite.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
    this.sqlite.exec(readFileSync('migrations/0002_v2_evidence_ready.sql', 'utf8'));
  }
  prepare(sql: string) { return new SqlStatement(this, sql); }
  async batch(statements: SqlStatement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}
