/**
 * Skills: once the agent has written a working audit for a schema, keep it.
 * A schema is identified by a fingerprint of its table, column and type names,
 * read by a fixed LeakFinder-owned probe (never by model-written code). The
 * probe output stays local: it is hashed, never shown to the model.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SKILLS_DIR = "skills";

/** Prints one `schema.table.column type` line per column, sorted. Names only: no rows, no counts. */
export const PROBE_PY = `import os, psycopg
with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
    rows = conn.execute(
        """select table_schema, table_name, column_name, data_type
             from information_schema.columns
            where table_schema not in ('pg_catalog', 'information_schema')
              and table_schema not like 'pg\\\\_%'
            order by 1, 2, 3"""
    ).fetchall()
for s, t, c, d in rows:
    print(f"{s}.{t}.{c} {d}")
`;

/** Stable across runs on the same schema: whitespace and line order do not matter. */
export function fingerprint(probeOutput: string): string {
  const lines = probeOutput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

export interface SkillMeta {
  fingerprint: string;
  savedAt: string;
  model: string;
  turns: number;
  rewrites: number;
  tables: number;
  columns: number;
}

export class SkillStore {
  constructor(readonly dir = SKILLS_DIR) {}

  private path(fp: string, kind: "audit" | "meta" | "fix") {
    return join(this.dir, kind === "audit" ? `${fp}.py` : kind === "meta" ? `${fp}.json` : `${fp}.fix.py`);
  }

  audit(fp: string): string | null {
    return this.read(this.path(fp, "audit"));
  }

  fix(fp: string): string | null {
    return this.read(this.path(fp, "fix"));
  }

  meta(fp: string): SkillMeta | null {
    const raw = this.read(this.path(fp, "meta"));
    try {
      return raw ? (JSON.parse(raw) as SkillMeta) : null;
    } catch {
      return null;
    }
  }

  saveAudit(fp: string, code: string, meta: Omit<SkillMeta, "fingerprint" | "savedAt">): string {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(fp, "audit"), code);
    const full: SkillMeta = { fingerprint: fp, savedAt: new Date().toISOString(), ...meta };
    writeFileSync(this.path(fp, "meta"), JSON.stringify(full, null, 2) + "\n");
    return this.path(fp, "audit");
  }

  saveFix(fp: string, code: string): string {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(fp, "fix"), code);
    return this.path(fp, "fix");
  }

  private read(p: string): string | null {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
}

/** Counts for the skill metadata, from the probe output (names only). */
export function schemaShape(probeOutput: string): { tables: number; columns: number } {
  const lines = probeOutput.split("\n").map((l) => l.trim()).filter(Boolean);
  const tables = new Set(lines.map((l) => l.split(" ")[0].split(".").slice(0, 2).join(".")));
  return { tables: tables.size, columns: lines.length };
}
