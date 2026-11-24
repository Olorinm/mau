"""Verify a restored database before starting writers. An optional operator-approved
manifest identifies exact expired coordination rows on a new, isolated replica.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def identifier(name):
    return '"' + name.replace('"', '""') + '"'


def records_digest(db, archived_ids):
    digest = hashlib.sha256()
    count = 0
    for name, in db.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"):
        if name == 'recovered_coordination_rows':
            continue
        digest.update(name.encode() + b'\0')
        for row in db.execute('SELECT rowid,* FROM ' + identifier(name) + ' NOT INDEXED ORDER BY rowid'):
            # Every retained row, including the current lease when present.
            if name == 'documents' and row[0] in archived_ids:
                continue
            content = json.dumps(row, ensure_ascii=False, default=lambda b: {'hex': b.hex()}, separators=(',', ':')).encode()
            digest.update(len(content).to_bytes(8, 'big') + content)
            count += 1
    return digest.digest(), count


def repair(db, expected, errors):
    if len(expected) != 2 or not all(re.fullmatch('[0-9a-f]{64}', value) for value in expected.values()):
        raise ValueError('invalid repair manifest')
    allowed_errors = r'(?:wrong # of entries in index|row [0-9]+ missing from index) (?:document_status|sqlite_autoindex_documents_1)'
    require(all(re.fullmatch(allowed_errors, row[0]) for row in errors), 'unexpected integrity errors')
    require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'foreign key errors')
    names = db.execute("SELECT name, sql FROM sqlite_schema WHERE tbl_name='documents'").fetchall()
    schema = dict(names)
    require(set(schema) == {'documents', 'document_status', 'sqlite_autoindex_documents_1'}, 'unexpected documents schema')
    require([v[1] for v in db.execute('PRAGMA table_info(documents)')] == ['collection','id','value'], 'unexpected columns')
    require(not db.execute("SELECT name FROM sqlite_schema WHERE tbl_name != 'documents' AND instr(lower(sql),'documents')>0").fetchall(), 'dependent schema')
    canonical = db.execute("SELECT rowid FROM documents INDEXED BY sqlite_autoindex_documents_1 WHERE collection='meta' AND id='lease'").fetchall()
    require(len(canonical) <= 1, 'ambiguous current lease')
    live_ids = {r[0] for r in canonical}
    physical = db.execute("SELECT rowid,value FROM documents NOT INDEXED WHERE collection='meta' AND id='lease'").fetchall()
    extra = {i: v for i,v in physical if i not in live_ids}
    require({str(i): hashlib.sha256(v.encode()).hexdigest() for i,v in extra.items()} == expected, 'expired lease fingerprints differ')
    require(all(json.loads(v)['expires'] < time.time()*1000 for v in extra.values()), 'lease has not expired')
    lookup = "SELECT rowid FROM documents INDEXED BY sqlite_autoindex_documents_1 WHERE collection=? AND id=?"
    for rowid, collection, key in db.execute('SELECT rowid,collection,id FROM documents NOT INDEXED'):
        if rowid not in extra:
            require(db.execute(lookup, (collection, key)).fetchall() == [(rowid,)], 'another document index entry differs')
    # Check both the number and the bytes of the records kept, including their original row IDs.
    before = records_digest(db, extra)
    db.execute('CREATE TABLE recovered_coordination_rows(original_rowid INTEGER PRIMARY KEY, collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL)')
    for i, value in extra.items():
        db.execute('INSERT INTO recovered_coordination_rows VALUES (?,?,?,?)', (i,'meta','lease',value))
    db.execute('ALTER TABLE documents RENAME TO documents_before_rebuild')
    db.execute(schema['documents'])
    db.execute('INSERT INTO documents(rowid,collection,id,value) SELECT rowid,collection,id,value FROM documents_before_rebuild NOT INDEXED WHERE rowid NOT IN (SELECT original_rowid FROM recovered_coordination_rows)')
    db.execute('DROP TABLE documents_before_rebuild')
    db.execute(schema['document_status'])
    require(records_digest(db, extra) == before, 'retained records differ')
    require(dict(db.execute('SELECT original_rowid,value FROM recovered_coordination_rows')) == extra, 'archived rows differ')
    require(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'integrity check after repair failed')
    require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'foreign key check after repair failed')
    print(json.dumps({'event':'restored_lease_rows_archived','rows':len(extra),'retained_rows':before[1]}), flush=True)


if __name__ == '__main__':
    path = Path(sys.argv[1]).resolve(strict=True)
    relative = sys.argv[2]
    manifest = json.loads(os.environ.get('STATE_LEASE_REPAIR') or '{}')
    expected = manifest.get(relative, {})
    db = sqlite3.connect(path.as_uri() + '?mode=rw', uri=True)
    try:
        db.execute('BEGIN IMMEDIATE')
        errors = db.execute('PRAGMA integrity_check').fetchall()
        if errors != [('ok',)]:
            require(expected and os.environ.get('STATE_PREFIX') and os.environ.get('STATE_PREFIX') != os.environ.get('STATE_SOURCE'), 'restored database integrity check failed')
            repair(db, expected, errors)
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'restored foreign key check failed')
        db.commit()
    finally:
        db.close()
