"""Guard against a false positive: an old State(normal) ACK is not exit completion."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
import asyncio

sys.modules.setdefault('livekit', types.SimpleNamespace(api=types.SimpleNamespace(), rtc=types.SimpleNamespace()))
spec = importlib.util.spec_from_file_location('p0_rtc_probe', Path(__file__).with_name('rtc-probe.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class AckBinding(unittest.IsolatedAsyncioTestCase):
    def probe(self, action, seq):
        probe = module.Probe.__new__(module.Probe)
        probe.consumer = module.V380Consumer('trace-1')
        probe.consumer.command(action, seq)
        probe.events = []
        probe.args = types.SimpleNamespace(scenario='normal')
        probe.log = lambda event, **kw: probe.events.append({'event': event, **kw})
        return probe

    async def receive(self, probe, seq, stage, state):
        await probe.handle_control({'type':'listening.ack', 'src':'worker', 'trace_id':'trace-1',
            'payload':{'version':1,'request_id':f'trace-1:{seq}','command_seq':seq,
                'stage':stage,'state':state,'mode_epoch':2}})

    async def test_normal_state_query_cannot_complete_later_exit(self):
        probe = self.probe('exit',5)
        probe.consumer.query(1)
        await self.receive(probe,1,'completed','normal')
        self.assertFalse(probe.ack('normal'))
        await self.receive(probe,5,'received','normal')
        self.assertFalse(probe.ack('normal'))
        await self.receive(probe,5,'completed','normal')
        self.assertTrue(probe.ack('normal'))

    async def test_local_ready_is_not_original_enter_completion(self):
        probe = self.probe('enter',2)
        await self.receive(probe,3,'completed','listening')
        self.assertFalse(probe.ack('listening'))
        probe.consumer.pending['received'] = True
        probe.consumer.local_ready_sent()
        await self.receive(probe,2,'completed','listening')
        self.assertTrue(probe.ack('listening'))

class IsolationScope(unittest.TestCase):
    def test_only_exact_isolated_roots_and_brain_children(self):
        for root in ['p003-listening-p0-20261030-session39', 'p003-listening-p0-v380-session39']:
            path = Path('/opt') / root / 'brain-123' / 'credentials.json'
            self.assertEqual(module.isolated_private_directory(path), path.parent)
        for root in ['p003-listening-canary-20261030', 'p003-listening-p0-v380-session38']:
            with self.assertRaises(ValueError):
                module.isolated_private_directory(Path('/opt') / root / 'brain-123' / 'credentials.json')
        with self.assertRaises(ValueError):
            module.isolated_private_directory('/opt/p003-listening-p0-v380-session39/production/credentials.json')

class AudioLifetime(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_pull_disposes_native_stream_before_loop_exits(self):
        started = asyncio.Event()
        class Stream:
            closed = False
            def __init__(self, *args, **kwargs): pass
            def __aiter__(self): return self
            async def __anext__(self):
                started.set()
                await asyncio.Future()
            async def aclose(self):
                Stream.closed = True
        module.rtc.AudioStream = Stream
        probe = module.Probe.__new__(module.Probe)
        task = asyncio.create_task(probe.pull(object()))
        await started.wait()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(Stream.closed, 'FFI subscriber must not survive asyncio loop')

if __name__ == '__main__':
    unittest.main()
