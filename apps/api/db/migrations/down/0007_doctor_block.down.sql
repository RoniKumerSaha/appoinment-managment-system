-- E0-S2: 0007 — doctor_block (down).

DROP INDEX IF EXISTS idx_doctor_block_doctor_branch_time;
DROP TRIGGER IF EXISTS trg_doctor_block_set_updated_at ON doctor_block;
DROP TABLE IF EXISTS doctor_block;
