import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]

class MigrationTests(unittest.TestCase):
    def database(self):
        db = sqlite3.connect(':memory:')
        db.executescript((ROOT / 'migrations/0001_init.sql').read_text())
        db.execute("""INSERT INTO cases
          (id,college,current_goal,work_location,hours_per_week,usage_context,status,
           access_token_hash,resume_r2_key,resume_filename,resume_content_type,attempt_count,
           created_at,updated_at)
          VALUES ('legacy','Green River College','Find work','Auburn','10-20','self','QUEUED',
                  'hash','temp/legacy/resume.txt','resume.txt','text/plain',0,
                  '2026-09-07T00:00:00.000Z','2026-09-07T00:00:00.000Z')""")
        return db

    def test_populated_migration_is_additive_idempotent_and_backfills_retention(self):
        db = self.database()
        migration = (ROOT / 'migrations/0002_v2_evidence_ready.sql').read_text()
        db.executescript(migration)
        db.executescript(migration)
        self.assertEqual(db.execute("SELECT status FROM cases WHERE id='legacy'").fetchone(), ('QUEUED',))
        artifact = db.execute("SELECT object_key,stored_at,delete_by FROM artifact_metadata WHERE case_id='legacy'").fetchone()
        self.assertEqual(artifact, ('temp/legacy/resume.txt', '2026-09-07T00:00:00.000Z', '2026-09-07T23:00:00.000Z'))
        self.assertEqual(db.execute("SELECT status FROM v2_deletion_index WHERE case_id='legacy'").fetchone(), ('PENDING',))

    def test_retention_boundaries_use_delete_by_directly(self):
        db = self.database()
        db.executescript((ROOT / 'migrations/0002_v2_evidence_ready.sql').read_text())
        query = "SELECT count(*) FROM v2_deletion_index WHERE status IN ('PENDING','FAILED') AND delete_by <= ?"
        self.assertEqual(db.execute(query, ('2026-09-07T22:59:59.999Z',)).fetchone()[0], 0)
        self.assertEqual(db.execute(query, ('2026-09-07T23:00:00.000Z',)).fetchone()[0], 1)

if __name__ == '__main__':
    unittest.main()
