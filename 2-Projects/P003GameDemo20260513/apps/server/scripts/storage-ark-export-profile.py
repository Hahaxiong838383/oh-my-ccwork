#!/usr/bin/env python3
"""Isolated T5 diagnostic only. Buffer SQL timings; write no log while holding locks."""
import argparse, hashlib, importlib.util, json, os, sqlite3, sys, time
from pathlib import Path

def profile_cycle(dbfile, root, output):
    dbfile, root, output = Path(dbfile).resolve(), Path(root).resolve(), Path(output).resolve()
    fixture = dbfile.parent
    if not fixture.name.startswith('p003-t5-') or json.loads((fixture/'config.json').read_text()).get('synthetic') is not True:
        raise ValueError('synthetic_fixture_required')
    if root.parent != fixture or output.parent != fixture or output.exists():
        raise ValueError('isolated_output_required')
    spec = importlib.util.spec_from_file_location('profiled_ark_export', Path(__file__).with_name('storage-ark-export.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    base = module.ExportConnection
    records, omitted, connections = [], [0], []
    def measure(db, phase, sql, operation):
        before = db.in_transaction; at = time.time_ns()/1e6; started = time.perf_counter_ns(); cpu = time.process_time_ns(); error = None
        try:
            return operation()
        except BaseException as e:
            error = getattr(e, 'sqlite_errorcode', type(e).__name__); raise
        finally:
            if len(records) < 2048:
                records.append({'phase':phase, 'sql_hash':hashlib.sha256(sql.encode()).hexdigest(),
                    'verb':sql.strip().split(None, 1)[0].upper(), 'started_at_ms':at,
                    'finished_at_ms':time.time_ns()/1e6, 'wall_ms':(time.perf_counter_ns()-started)/1e6,
                    'cpu_ms':(time.process_time_ns()-cpu)/1e6, 'before_transaction':before,
                    'after_transaction':db.in_transaction, 'error':error})
            else:
                omitted[0] += 1
    class Cursor:
        def __init__(self, db, cursor, sql): self.db, self.cursor, self.sql = db, cursor, sql
        def fetchall(self): return measure(self.db, 'fetchall', self.sql, self.cursor.fetchall)
        def fetchone(self): return measure(self.db, 'fetchone', self.sql, self.cursor.fetchone)
        def __getattr__(self, name): return getattr(self.cursor, name)
        def __iter__(self): return iter(self.cursor)
    class Profiled(base):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            connections.append({'sqlite_version':sqlite3.sqlite_version,
                'synchronous':super().execute('PRAGMA synchronous').fetchone()[0],
                'wal_autocheckpoint':super().execute('PRAGMA wal_autocheckpoint').fetchone()[0],
                'busy_timeout':super().execute('PRAGMA busy_timeout').fetchone()[0]})
        def execute(self, sql, *a, **kw):
            cursor = measure(self, 'execute', sql, lambda:super(Profiled,self).execute(sql,*a,**kw))
            return Cursor(self, cursor, sql)
        def commit(self): return measure(self, 'commit', 'COMMIT', lambda:super(Profiled,self).commit())
        def rollback(self): return measure(self, 'rollback', 'ROLLBACK', lambda:super(Profiled,self).rollback())
    class ConnectionFactory:
        # Keep ExportConnection's global name stable: its explicit super()
        # depends on that class, so replacing the name would recurse.
        def connect(self, *a, **kw):
            if kw.get('factory') is base: kw['factory'] = Profiled
            return sqlite3.connect(*a, **kw)
        def __getattr__(self, name): return getattr(sqlite3, name)
    module.sqlite3 = ConnectionFactory()
    result, error = None, None
    try:
        result = module.cycle(dbfile, root); return result
    except BaseException as e:
        error = type(e).__name__; raise
    finally:
        # cycle closes its DB before this flush, including its exception path.
        with output.open('x') as f:
            os.chmod(output, 0o600)
            json.dump({'scope':'SYNTHETIC_SQL_TIMING_NO_BOUND_VALUES', 'pid':os.getpid(),
                'connections':connections, 'records':records, 'omitted':omitted[0],
                'result':result, 'error':error, 'flushed_after_cycle':True}, f)

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db', required=True); p.add_argument('--root', required=True); p.add_argument('--profile', required=True)
    a=p.parse_args()
    try: print(json.dumps(profile_cycle(a.db,a.root,a.profile)))
    except Exception as e:
        print('ARK_EXPORT_FAILED:'+type(e).__name__+':'+str(getattr(e,'sqlite_errorname','NON_SQLITE')),file=sys.stderr); raise SystemExit(1)
