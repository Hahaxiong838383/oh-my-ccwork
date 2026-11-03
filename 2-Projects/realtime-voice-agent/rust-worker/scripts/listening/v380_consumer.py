"""Software probe observation model of Android 6558e03 ListeningVoiceController.

Only models ACK consumption/reset, not Android audio/UI or its coroutine timers.
RTC sender kind/name/identity/SID/room checks remain in the probe. Deliberately
retains v380's rejected/failed mismatch; accepting a nicer invented protocol
would hide the interoperability failure. Independent JVM replay is separate.
"""


class V380Consumer:
    def __init__(self, trace):
        self.trace = trace
        self.state = 'normal'
        self.connected = True
        self.pending = None
        self.queries = []
        self.epoch = 0
        self.recovery = False

    def command(self, action, seq):
        self.pending = {'action': action, 'seq': seq, 'received': False}
        self.state = 'preparing'

    def query(self, seq):
        self.queries.append(f'{self.trace}:{seq}')
        self.queries = self.queries[-4:]

    def ack(self, message):
        if not self.connected or message.get('src') != 'worker' or message.get('trace_id') != self.trace:
            return 'untrusted'
        p = message['payload']
        if p.get('version') != 1:
            return 'version_mismatch'
        state, epoch = p['state'], p['mode_epoch']
        if p['request_id'] in self.queries:
            self.epoch = max(self.epoch, epoch)
            if state in ['paused', 'unknown']:
                self.state, self.recovery = 'paused', True
            elif state in ['normal', 'listening', 'feedback']:
                if self.pending is None:
                    self.state = state
            elif state != 'entering':
                self.state, self.recovery = 'paused', True
            return 'state_snapshot'
        current = self.pending
        if current is None or p['request_id'] != f"{self.trace}:{current['seq']}" or p['command_seq'] != current['seq']:
            return 'request_mismatch'
        if p['stage'] == 'received':
            if current['received']:
                return 'duplicate_received'
            current['received'] = True
            self.epoch = max(self.epoch, epoch)
            return 'local_ready' if current['action'] == 'enter' else 'received'
        if p['stage'] == 'completed':
            expected = 'listening' if current['action'] == 'enter' else 'normal'
            if state != expected:
                self.state, self.recovery = 'paused', True
                return 'completion_state_invalid'
            self.epoch = max(self.epoch, epoch)
            self.pending, self.state = None, expected
            return current['action'] + '_completed'
        if p['stage'] == 'failed':
            self.state, self.recovery = 'paused', True
            return 'failed'
        return 'stage_unknown'

    def disconnected(self):
        self.connected = False
        self.state, self.pending, self.epoch = 'normal', None, 0
        self.queries.clear()
