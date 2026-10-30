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

class AckBinding(unittest.TestCase):
    def test_normal_state_query_cannot_complete_later_exit(self):
        probe = module.Probe.__new__(module.Probe)
        probe.commands = {'enter': 2, 'exit': 5}
        probe.messages = [{'type':'listening.ack', 'payload':{'command_seq':1, 'stage':'completed', 'state':'normal'}}]
        self.assertFalse(probe.ack('normal'))
        probe.messages.append({'type':'listening.ack', 'payload':{'command_seq':5, 'stage':'received', 'state':'normal'}})
        self.assertFalse(probe.ack('normal'))
        probe.messages.append({'type':'listening.ack', 'payload':{'command_seq':5, 'stage':'completed', 'state':'normal'}})
        self.assertTrue(probe.ack('normal'))

    def test_local_ready_is_not_original_enter_completion(self):
        probe = module.Probe.__new__(module.Probe)
        probe.commands = {'enter': 2}
        probe.messages = [{'type':'listening.ack', 'payload':{'command_seq':3, 'stage':'completed', 'state':'listening'}}]
        self.assertFalse(probe.ack('listening'))
        probe.messages.append({'type':'listening.ack', 'payload':{'command_seq':2, 'stage':'completed', 'state':'listening'}})
        self.assertTrue(probe.ack('listening'))

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
