-- 0003_pack_order: a stored display order for the Pack list (SPM-25).
-- 1 = top of the list, contiguous 1..N after every operation. Display only:
-- it never names a folder or a file (ADR-0003 is about sticker order).
-- Existing packs are backfilled newest-first (highest id on top), so the list
-- reads newest-first from the upgrade on, like new packs, which go on top.

ALTER TABLE packs ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE packs SET sort_order =
    (SELECT COUNT(*) FROM packs AS later WHERE later.id >= packs.id);
