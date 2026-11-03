#!/usr/bin/env python3
"""Replay the actual read-only query against synthetic LOCAL SQLite only.

No network/production connection. Frozen time keeps this fixture reproducible.
Each old JSON path must fail on nonempty rows; the corrected script must pass.
"""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from unittest.mock import patch


def verify():
    source = Path(__file__).with_name('reconcile_day_readonly.py').read_text()
    key = 'a' * 64
    diag = 'diag-121d6b4b-a9ed-43b2-975c-786542d8b9ae'
    received = 1793684512333
    with tempfile.TemporaryDirectory(prefix='p003-local-fixture-') as folder:
        dbpath = Path(folder) / 'synthetic.sqlite'
        db = sqlite3.connect(dbpath)
        db.executescript('''
        CREATE TABLE analytics_batch(attempt_id,device_key,request_id,batch_id,
          received_at_ms,sent_at_ms,accepted,duplicated,rejected,http_status,client_json);
        CREATE TABLE analytics_transport(attempt_id,encoding,wire_bytes,inflated_bytes);
        CREATE TABLE analytics_settlement(attempt_id,outcome,reason);
        CREATE TABLE analytics_event(batch_attempt_id,device_key,received_at_ms);
        CREATE TABLE analytics_tier_event(batch_attempt_id,device_key,received_at_ms,
          tier,source_event_name,diagnostic_request_id,source_event_count,
          client_event_id,occurred_at_ms,properties_json);
        CREATE TABLE analytics_diagnostic_usage(device_key,request_id,accepted);
        ''')
        db.execute('INSERT INTO analytics_batch VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                   ('fixture-attempt', key, 'fixture-rid', 'fixture-batch', received,
                    received-1, 3, 0, 0, 200,
                    json.dumps({'content_version':'fixture-content','app_version':'fixture-app'})))
        db.execute('INSERT INTO analytics_transport VALUES(?,?,?,?)',
                   ('fixture-attempt','gzip',100,300))
        db.executemany('INSERT INTO analytics_settlement VALUES(?,?,?)',
                       [('fixture-attempt','accepted',None)]*3)
        db.execute('INSERT INTO analytics_event VALUES(?,?,?)',('fixture-attempt',key,received))
        for tier in ('diagnostic','aggregate'):
            db.execute('INSERT INTO analytics_tier_event VALUES(?,?,?,?,?,?,?,?,?,?)',
                       ('fixture-attempt',key,received,tier,'fixture.event',
                        diag if tier=='diagnostic' else None,1,'fixture-'+tier,
                        received-1,json.dumps({'period_start_ms':received-1000,
                                              'period_end_ms':received-1})))
        db.execute('INSERT INTO analytics_diagnostic_usage VALUES(?,?,?)',(key,diag,1))
        db.commit()
        db.close()
        before = hashlib.sha256(dbpath.read_bytes()).hexdigest()

        def run(code):
            captured = io.StringIO()
            scope = {'__name__':'__main__'}
            try:
                with patch.dict(os.environ, {'P003_ANALYTICS_AUDIT_DB':str(dbpath),
                                              'P003_ANALYTICS_AUDIT_DEVICE_KEY':key}), \
                     patch.object(sys,'argv',['reconcile_day_readonly.py','--date-cst','2026-11-03']), \
                     patch('time.time',return_value=(received+10000)/1000), \
                     contextlib.redirect_stdout(captured):
                    exec(compile(code,'reconcile_day_readonly.py','exec'),scope)
                return json.loads(captured.getvalue())
            finally:
                if scope.get('c'):
                    scope['c'].close()

        result = run(source)
        assert result['summary']==[{'attempts':1,'accepted':3,'duplicated':0,'rejected':0}]
        assert result['batches'][0]['content_version']=='fixture-content'
        assert result['batches'][0]['app_version']=='fixture-app'
        assert len(result['aggregate_periods'])==1
        assert result['aggregate_periods'][0]['period_start_ms']==received-1000
        assert result['aggregate_periods'][0]['period_end_ms']==received-1
        assert result['has_real_window_traffic']  # Nonempty fixture, NOT production evidence.
        assert result['settlement_count_matches_attempt_totals']
        assert result['accepted_payload_count_matches']
        assert result['usage'][0]['accepted']==1
        assert {r['tier']:r['records'] for r in result['payload_by_batch']}=={
            'raw':1,'diagnostic':1,'aggregate':1}
        failures=[]
        for field in ('content_version','app_version','period_start_ms','period_end_ms'):
            assert source.count("'$."+field+"'")==1
            broken = source.replace("'$."+field+"'", "'"+field+"'")
            try:
                run(broken)
            except sqlite3.OperationalError as error:
                assert 'JSON path' in str(error), str(error)
                failures.append(field)
            else:
                raise AssertionError('Old path did not fail: '+field)
        assert hashlib.sha256(dbpath.read_bytes()).hexdigest()==before
        return {'environment':'local synthetic temporary SQLite only',
                'production_access':False,'production_acceptance_claim':False,
                'query_script_sha256':hashlib.sha256(source.encode()).hexdigest(),
                'nonempty_batches':1,'fixture_accepted':3,
                'fixture_tiers':{'raw':1,'diagnostic':1,'aggregate':1},
                'corrected_full_script_pass':True,'old_path_failure_verified':failures,
                'fixture_database_unchanged':True}


if __name__=='__main__':
    print(json.dumps(verify(),ensure_ascii=False,indent=2))
