"""Best-effort durable operation records. A telemetry outage never stops processing."""
import os
import threading
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4
from .clients import get_supabase_client


def safe_reference(value):
    if not value:
        return None
    if '://' in value:
        parsed = urlsplit(value)
        return urlunsplit((parsed.scheme, parsed.hostname or '', parsed.path, '', ''))[:500]
    return str(value)[:500]


class OperationTrace:
    def __init__(self, kind, reference=None, client=None):
        self.id = str(uuid4())
        self.client = None
        self.had_errors = False
        self.lock = threading.Lock()
        if os.getenv('OPS_TELEMETRY_ENABLED', '1') == '0':
            return
        try:
            self.client = client or get_supabase_client()
            self.client.table('ops_runs').insert({
                'id': self.id, 'kind': kind, 'reference': safe_reference(reference),
                'status': 'running', 'stage': 'accepted', 'message': 'Operation started',
            }).execute()
        except Exception:
            self.client = None
            print('Observability unavailable; processing continues.')

    def stage(self, stage, message, details=None, level='info'):
        if level == 'error':
            self.had_errors = True
        if not self.client:
            return
        try:
            with self.lock:
                self.client.table('ops_events').insert({
                    'run_id': self.id, 'stage': stage, 'message': message,
                    'level': level, 'details': details or {},
                }).execute()
                self.client.table('ops_runs').update({
                    'stage': stage, 'message': message,
                    'updated_at': datetime.now(timezone.utc).isoformat(),
                }).eq('id', self.id).execute()
        except Exception:
            print('Observability event could not be recorded; processing continues.')

    def finish(self, status='succeeded', message='Operation completed', details=None):
        if status == 'succeeded' and self.had_errors:
            status = 'partial'
        if not self.client:
            return
        self.stage('finished', message, details, 'error' if status == 'failed' else 'warning' if status == 'partial' else 'info')
        try:
            now = datetime.now(timezone.utc).isoformat()
            with self.lock:
                self.client.table('ops_runs').update({
                    'status': status, 'message': message, 'details': details or {},
                    'finished_at': now, 'updated_at': now,
                }).eq('id', self.id).execute()
        except Exception:
            print('Observability completion could not be recorded; processing continues.')
