import { DatabaseSync } from "node:sqlite";

/** Repository boundary. Store depends on these row/transaction methods, not SQLite APIs. */
export class SqliteRepository {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file);
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version !== 0 && version !== 2) {
      this.db.close();
      throw Error("不支持的数据库版本：" + version);
    }
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL,
        styles TEXT NOT NULL, warnings TEXT NOT NULL, original TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sections (
        id TEXT PRIMARY KEY, parent_id TEXT REFERENCES sections(id) DEFERRABLE INITIALLY DEFERRED,
        heading_block_id TEXT NOT NULL UNIQUE, position REAL NOT NULL, revision INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sections_parent ON sections(parent_id,position,id);
      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES sections(id) DEFERRABLE INITIALLY DEFERRED,
        position REAL NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blocks_section ON blocks(section_id,position,id);
      CREATE TABLE IF NOT EXISTS assets(path TEXT PRIMARY KEY, media_type TEXT, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS change_log(id TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE, operation TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revision_heads(id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      PRAGMA user_version=2;
    `);
    this.statements = new Map();
  }
  stmt(sql) {
    if (!this.statements.has(sql))
      this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  get(sql, ...args) {
    return this.stmt(sql).get(...args);
  }
  all(sql, ...args) {
    return this.stmt(sql).all(...args);
  }
  run(sql, ...args) {
    return this.stmt(sql).run(...args);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  document() {
    return this.get("SELECT * FROM documents");
  }
  section(id) {
    return this.get("SELECT * FROM sections WHERE id=?", id);
  }
  block(id) {
    return this.get("SELECT * FROM blocks WHERE id=?", id);
  }
  sections() {
    return this.all("SELECT * FROM sections ORDER BY position,id");
  }
  blocks(id) {
    return this.all(
      "SELECT * FROM blocks WHERE section_id=? ORDER BY position,id",
      id,
    );
  }
  entries(parent) {
    return this.all(
      "SELECT id,position,'section' kind FROM sections WHERE parent_id IS ? UNION ALL SELECT id,position,'block' kind FROM blocks WHERE section_id IS ? ORDER BY position,id",
      parent,
      parent,
    );
  }
  putSection(s) {
    this.run(
      "INSERT INTO sections(id,parent_id,heading_block_id,position,revision) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,heading_block_id=excluded.heading_block_id,position=excluded.position,revision=excluded.revision",
      s.id,
      s.parent_id,
      s.heading_block_id,
      s.position,
      s.revision,
    );
    this.head(s.id, s.revision);
  }
  putBlock(b) {
    this.run(
      "INSERT INTO blocks(id,section_id,position,type,content,revision) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET section_id=excluded.section_id,position=excluded.position,type=excluded.type,content=excluded.content,revision=excluded.revision",
      b.id,
      b.section_id,
      b.position,
      b.type,
      b.content,
      b.revision,
    );
    this.head(b.id, b.revision);
  }
  head(id, rev) {
    this.run(
      "INSERT INTO revision_heads(id,revision) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=MAX(revision,excluded.revision)",
      id,
      rev,
    );
  }
  nextRevision(id) {
    return (
      (this.get("SELECT revision FROM revision_heads WHERE id=?", id)
        ?.revision || 0) + 1
    );
  }
  integrity() {
    const ok = this.get("PRAGMA integrity_check").integrity_check;
    if (ok !== "ok" || this.all("PRAGMA foreign_key_check").length)
      throw Error("SQLite 数据完整性校验失败");
    if (
      this.get(
        "SELECT COUNT(*) n FROM sections s LEFT JOIN blocks b ON b.id=s.heading_block_id WHERE b.id IS NULL OR b.section_id<>s.id OR b.type<>?",
        "heading",
      ).n
    )
      throw Error("章节标题归属校验失败");
    return true;
  }
  checkpoint() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close() {
    this.db.close();
  }
}
