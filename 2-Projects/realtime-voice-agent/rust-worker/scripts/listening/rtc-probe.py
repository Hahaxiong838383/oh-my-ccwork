#!/usr/bin/env python3
"""Isolated P003 software device. No dotenv, token fabrication or production dispatch.
Requires a private credential file created by listening-rtc-brain and process-only
LiveKit API credentials for narrowly scoped cleanup/listing. Synthetic WAVs only.
Evidence is client-observed; ASR/TTS are real, Brain text provider is labelled fake.
"""
import argparse
import asyncio
import array
import hashlib
import json
import os
import signal
import sqlite3
import struct
import time
import urllib.request
import uuid
import wave
from pathlib import Path
from livekit import api, rtc

SR = 16000
HISTORY = 'p003.audio.history.v1'


def pcm(path):
    with wave.open(str(path)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, SR)
        return w.readframes(w.getnframes())


def http_json(url, body=None, bearer=None):
    headers = {'content-type': 'application/json'}
    if bearer:
        headers['authorization'] = 'Bearer ' + bearer
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=8) as response:
        return json.load(response)


class Probe:
    def __init__(self, args):
        self.args = args
        self.creds = json.loads(Path(args.credentials).read_text())
        assert Path(args.credentials).stat().st_mode & 0o077 == 0
        assert self.creds['agent'].startswith('p003-listening-p0-')
        self.room = rtc.Room()
        self.events = []
        self.started = time.monotonic()
        self.trace = 'p0-39-' + str(uuid.uuid4())
        self.seq = 0
        self.messages = []
        self.packets = []
        self.commands = {}
        self.proposals = set()
        self.binding = None
        self.tasks = []
        self.audio = []
        self.captions = []
        self.queue = asyncio.Queue()
        self.sent_frames = 0
        self.mic = None
        self.signed = None
        self.disconnected = False
        self.control_lock = asyncio.Lock()
        self.failure = None

    def log(self, event, **values):
        row = {'mono_ns':time.monotonic_ns(), 't_ms': round((time.monotonic()-self.started)*1000), 'event': event, **values}
        self.events.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)

    async def wait(self, predicate, name, seconds=15):
        end = time.monotonic()+seconds
        while not predicate():
            if self.failure:
                raise AssertionError(self.failure)
            if time.monotonic() >= end:
                raise AssertionError('timeout: '+name)
            await asyncio.sleep(.025)
        self.log('assertion', name=name, passed=True)

    def trusted(self, p):
        if p is None or p.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
            return False
        if p.attributes.get('lk.agent.name') != self.creds['agent']:
            return False
        pair = (p.identity, p.sid)
        if self.binding is None:
            self.binding = pair
            self.log('agent_bound', identity=p.identity, sid=p.sid, kind=int(p.kind), agent=p.attributes.get('lk.agent.name'))
        return pair == self.binding

    async def send_control(self, kind, payload, replay=None):
        async with self.control_lock:
            if replay is None:
                self.seq += 1
                payload = {'version': 1, 'request_id': f'{self.trace}:{self.seq}', **payload}
                value = {'trace_id': self.trace, 'ts_ms': int(time.time()*1000), 'src': 'android', 'type': kind, 'seq': self.seq, 'payload': payload}
            else:
                value = replay
            await self.room.local_participant.publish_data(json.dumps(value).encode(), reliable=True, topic='control')
            self.log('control_sent', type=kind, seq=value['seq'], payload=value['payload'])
            return value

    async def handle_control(self, value):
        p = value.get('payload', {})
        if value['type'] == 'listening.proposal':
            proposal = p['proposal_id']
            if proposal in self.proposals:
                return
            assert p['version'] == 1 and p['session_id'] == self.signed['session_id']
            assert p['participant'] == self.signed['identity'] and 0 < p['ttl_ms'] <= 3000
            self.proposals.add(proposal)
            if self.args.scenario == 'proposal_timeout':
                return
            # Query deliberately arrives before acceptance and must not consume it.
            await self.send_control('listening.state', {})
            body = {'mode_epoch': p['mode_epoch'], 'proposal_id': proposal}
            if p['action'] == 'enter':
                body['scene'] = p['scene']
            self.enter_command = await self.send_control('listening.'+p['action'], body)
            self.commands[p['action']] = self.enter_command['seq']
            # Exact same seq/payload retransmission, never a second allocator.
            await self.send_control('listening.'+p['action'], body, self.enter_command)
        elif value['type'] == 'listening.ack' and p.get('state') == 'entering' and p.get('stage') == 'received':
            if self.args.scenario == 'missing_ready' or getattr(self, 'ready_sent', False):
                return
            # Software device has no local player; drain is genuinely empty.
            self.ready_sent = True
            await self.send_control('listening.local_ready', {'mode_epoch': p['mode_epoch']})

    async def pull(self, track):
        stream = rtc.AudioStream(track, sample_rate=24000, num_channels=1)
        try:
            async for event in stream:
                values = array.array('h', bytes(event.frame.data))
                peak = max((abs(x) for x in values), default=0)
                if peak > 100:
                    self.audio.append({'mono_ns':time.monotonic_ns(), 't_ms': round((time.monotonic()-self.started)*1000), 'peak': peak, 'samples': len(values)})
                    if len(self.audio) == 1:
                        self.log('first_nonzero_audio', peak=peak)
        finally:
            await stream.aclose()

    async def pump(self):
        frame_bytes = SR//50*2
        while True:
            try:
                label, data = self.queue.get_nowait()
                if getattr(self,'last_fixture',None)!=label:
                    self.last_fixture=label
                    if label=='barge':self.barge_sent_ns=time.monotonic_ns()
                    self.log('uplink_fixture_start',fixture=label)
            except asyncio.QueueEmpty:
                data = None
            raw = data if data is not None else bytes(frame_bytes)
            frame = rtc.AudioFrame.create(SR, 1, SR//50)
            memoryview(frame.data).cast('B')[:] = raw.ljust(frame_bytes, b'\0')
            await self.mic.capture_frame(frame)
            self.sent_frames += 1
            if data is not None:
                self.queue.task_done()
            await asyncio.sleep(.02)

    async def speak(self, name):
        data = pcm(Path(self.args.fixtures)/(name+'.wav'))
        self.log('synthetic_uplink', fixture=name, sha256=hashlib.sha256(data).hexdigest(), samples=len(data)//2)
        for i in range(0, len(data), 640):
            await self.queue.put((name,data[i:i+640]))
        await self.queue.join()

    async def ordered(self):
        split = self.args.entry_style == 'wake-tail'
        data = pcm(Path(self.args.fixtures)/('wake.wav' if split else 'enter.wav'))
        self.log('entry_fixture', style=self.args.entry_style, sha256=hashlib.sha256(data).hexdigest())
        base = {'input_id': 'p0-input-'+str(uuid.uuid4()), 'trace_id': self.trace, 'session_id': self.signed['session_id'], 'capture_epoch': 1, 'wake_generation': 1, 'keep_from': 0, 'boundary_kind': 'kws_tail', 'overlaps_local_playback': False, 'sr': SR, 'ch': 1, 'fmt': 's16le'}
        async def send(t, seq, start, end, body=b''):
            header = {**base, 't': t, 'seq': seq, 'start': start, 'end': end, 'sent_at_ms': int(time.time()*1000)}
            raw = json.dumps(header).encode()
            await self.room.local_participant.publish_data(b'OPCM'+struct.pack('>HH', 1, len(raw))+raw+body, reliable=True, topic=HISTORY)
        await send('begin', 0, 0, 0)
        seq = 0
        for offset in range(0, len(data)//2, 640):
            end = min(offset+640, len(data)//2)
            await send('chunk', seq, offset, end, data[offset*2:end*2])
            seq += 1
            await asyncio.sleep(.005)
        await send('end', seq, len(data)//2, len(data)//2)
        self.log('ordered_end', samples=len(data)//2)
        if split:
            # Diagnostic case, not a fabricated STT/control event. The real ASR
            # receives a wake-only ordered segment, then the rest over RTP.
            await self.wait(lambda: any(v.get('type') == 'session.input_phase'
                and v.get('payload', {}).get('phase') == 'rtc' for v in self.messages),
                'wake-only phase to RTP')
            await asyncio.sleep(.4)
            await self.speak('enter_tail')
        # Begin real RTP narration immediately after end, while first ASR closes.
        self.story_task = asyncio.create_task(self.speak('story'))

    def ack(self, state):
        action = 'exit' if state == 'normal' else 'enter'
        return any(v.get('type') == 'listening.ack' and v.get('payload', {}).get('command_seq') == self.commands.get(action) and v['payload'].get('stage') == 'completed' and v['payload'].get('state') == state for v in self.messages)

    async def run(self):
        session = await asyncio.to_thread(http_json, self.args.base+'/v1/device/session', {'device_sn': self.creds['device_sn'], 'trace_id': self.trace, 'supports': ['oneshot_first_turn_v1', 'local_receipt_v1', 'listening_mode_v1', 'listening_voice_control_v1']}, self.creds['device_bearer'])
        assert session.get('listening_contract', {}).get('voice_control'), 'real registration/config ACK missing'
        assert session['expected_agent_name'] == self.creds['agent']
        assert session['contract']['input_mode'] == 'ordered_pcm'
        self.signed = session
        self.log('session_issued', room=session['room_name'], session=session['session_id'], trace=self.trace, agent=session['expected_agent_name'])
        @self.room.on('data_received')
        def on_data(packet):
            if getattr(self, 'closing', False):
                return
            if not self.trusted(packet.participant):
                self.log('untrusted_packet', topic=packet.topic)
                return
            if packet.topic == HISTORY:
                version, size = struct.unpack('>HH', packet.data[4:8])
                value = json.loads(packet.data[8:8+size])
                self.log('ordered_received', **value)
                return
            try:
                value = json.loads(packet.data)
            except ValueError:
                self.log('non_json_data', topic=packet.topic)
                return
            self.log('data_received', topic=packet.topic, value=value)
            self.packets.append({'topic':packet.topic, 'value':value, 't_ms':round((time.monotonic()-self.started)*1000)})
            if packet.topic == 'control':
                if value.get('trace_id') != self.trace:
                    return
                self.messages.append(value)
                task = asyncio.create_task(self.handle_control(value))
                def checked(t):
                    if not t.cancelled() and t.exception():
                        self.failure = repr(t.exception())
                task.add_done_callback(checked)
                self.tasks.append(task)
        @self.room.on('track_subscribed')
        def on_track(track, publication, participant):
            if track.kind == rtc.TrackKind.KIND_AUDIO and self.trusted(participant):
                self.log('audio_subscribed', sid=publication.sid)
                self.tasks.append(asyncio.create_task(self.pull(track)))
        @self.room.on('transcription_received')
        def on_caption(segments, participant, publication):
            for segment in segments:
                row = {'identity': participant.identity if participant else None, 'id': segment.id, 'text': segment.text, 'final': segment.final, 't_ms': round((time.monotonic()-self.started)*1000)}
                self.captions.append(row)
                self.log('transcription', **row)
        @self.room.on('disconnected')
        def on_disconnect(reason):
            self.disconnected = True
            self.log('disconnected', reason=str(reason))
        await self.room.connect(session['server_url'], session['token'])
        # Delay only this software client's microphone publication. The actual
        # job/prebuild is already running: exercises idle ASR takeover without
        # changing SFU, provider, timeouts or any production service.
        delay_ms = self.args.mic_publish_delay_ms
        assert 0 <= delay_ms <= 12000
        if delay_ms:
            self.log('delayed_microphone_publication_start', delay_ms=delay_ms)
            await asyncio.sleep(delay_ms/1000)
            self.log('delayed_microphone_publication_end', delay_ms=delay_ms)
        self.mic = rtc.AudioSource(SR, 1, queue_size_ms=100)
        await self.room.local_participant.publish_track(rtc.LocalAudioTrack.create_audio_track('p0-synthetic-mic', self.mic), rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        self.tasks.append(asyncio.create_task(self.pump()))
        await self.wait(lambda: any(v.get('type') == 'session.input_ready' for v in self.messages), 'real input_ready')
        await self.ordered()
        if self.args.scenario in ['missing_ready', 'proposal_timeout']:
            await self.wait(lambda: self.disconnected, 'client observes server disconnect', 18)
            assert not self.audio and not self.ack('listening')
        else:
            await self.wait(lambda: self.ack('listening'), 'enter double-confirm completed')
            await self.story_task
            await asyncio.sleep(2)
            assert not self.audio, 'ordinary narration produced audible output'
            assert not any(v['topic']=='metrics' and v['value'].get('k')=='eou' for v in self.packets), 'narration committed ordinary turn'
            assert not any(c['final'] and c['text'] and c['identity']==self.binding[0] for c in self.captions), 'narration produced agent caption'
            assert not any(v.get('type') == 'listening.ack' and v['payload'].get('state') == 'paused' for v in self.messages)
            self.log('assertion', name='narration silent, State nonconflicting, duplicate accepted', passed=True)
            if self.args.scenario in ['revoke', 'lease_timeout']:
                if self.args.scenario == 'revoke':
                    self.set_isolated_enabled(False)
                else:
                    private=Path(self.args.credentials).resolve().parent
                    parent=private.parent
                    assert parent.name=='p003-listening-p0-20261030-session39'
                    pid=int((parent/'brain.pid').read_text())
                    assert Path('/proc',str(pid),'exe').resolve()==parent/'node'
                    os.kill(pid,signal.SIGSTOP)
                    self.paused_brain=pid
                    self.log('isolated_authority_paused', pid=pid)
                await self.wait(lambda:self.disconnected, 'client observes lease/revocation disconnect', 15)
                assert not self.audio
                self.log('assertion',name='no output under failed authorization',passed=True)
            elif self.args.scenario == 'disconnect':
                await self.room.disconnect()
            else:
                await self.speak('feedback')
                await self.wait(lambda: bool(self.audio), 'real feedback audio received', 18)
                if self.args.scenario == 'barge':
                    await self.speak('barge')
                    await asyncio.sleep(1)
                    count = len(self.audio)
                    await asyncio.sleep(3)
                    assert len(self.audio) == count, 'old feedback resumed'
                    last=max(v['mono_ns'] for v in self.audio)
                    stop_ms=(last-self.barge_sent_ns)/1_000_000
                    assert stop_ms<=1200, f'barge audible stop outside bound: {stop_ms}ms'
                    self.log('assertion', name='acoustic interruption bounded stop and no resumed audio', passed=True,stop_from_uplink_ms=stop_ms,last_audio_mono_ns=last,uplink_start_mono_ns=self.barge_sent_ns)
                else:
                    feedback_started=self.audio[0]['t_ms']
                    await self.wait(lambda:any(v['topic']=='state' and v['value'].get('speaking') is False and v['t_ms']>feedback_started for v in self.packets),'uninterrupted feedback finished',20)
                    self.log('uninterrupted_feedback_duration',audio_ms=self.audio[-1]['t_ms']-feedback_started)
                await self.speak('exit')
                await self.wait(lambda: self.ack('normal'), 'voice exit normal')
                assert not self.disconnected
                count = len(self.audio)
                await asyncio.sleep(1.2)
                assert len(self.audio) == count, 'old audio after exit'
                chat_start = round((time.monotonic()-self.started)*1000)
                await self.speak('chat')
                await self.wait(lambda: len(self.audio) > count, 'ordinary chat audible after voice exit', 18)
                await self.wait(lambda:any(c['final'] and c['text'] and c['identity']==self.binding[0] and c['t_ms']>=chat_start for c in self.captions),'ordinary final subtitle',12)
                assert any(c['final'] and c['text'] and c['identity']==self.binding[0] and c['t_ms']>=chat_start for c in self.captions), 'ordinary anchor missing agent subtitles'
                assert any(v['topic']=='metrics' and v['t_ms']>=chat_start for v in self.packets), 'ordinary anchor missing metrics'
                self.log('assertion', name='ordinary chat audio/subtitles/metrics positive anchor', passed=True)
                provider=Path(self.args.credentials).parent/'provider-observations.json'
                rows=json.loads(provider.read_text())
                feedback=[v for v in rows if v.get('trace_id')==self.trace and v.get('purpose')=='listening_feedback']
                assert len(feedback)==1, 'feedback must consume one request/permit'
                assert feedback[0].get('markers',{}).get('紫色风筝') is True, 'immediate continuation marker missing at Brain provider input'
                self.log('assertion',name='one feedback includes immediate synthetic tail marker',passed=True,observation=feedback[0])
        self.log('summary', scenario=self.args.scenario, audio_nonzero_frames=len(self.audio), caption_events=len(self.captions), uplink_frames=self.sent_frames, control_types=[v.get('type') for v in self.messages], server_disconnected=self.disconnected)

    def set_isolated_enabled(self, enabled):
        private=Path(self.args.credentials).resolve().parent
        assert private.parent.name=='p003-listening-p0-20261030-session39' and private.name.startswith('brain-')
        db=sqlite3.connect(private/'config.db')
        try:
            db.execute('BEGIN IMMEDIATE')
            before=json.loads(db.execute('SELECT value_json FROM listening_settings WHERE id=1').fetchone()[0])
            after={**before,'enabled':enabled,'revision':before['revision']+1}
            at=int(time.time()*1000)
            db.execute('UPDATE listening_settings SET revision=?,value_json=?,updated_at=?,updated_by=? WHERE id=1',(after['revision'],json.dumps(after),at,'isolated-rtc-test'))
            db.execute('INSERT INTO listening_settings_audit VALUES (?,?,?,?,?,?)',(after['revision'],'save' if enabled else 'disable','isolated-rtc-test',at,json.dumps(before),json.dumps(after)))
            db.commit()
            self.log('isolated_config_changed',enabled=enabled,revision=after['revision'])
        finally:
            db.close()

    async def close(self):
        self.closing = True
        if hasattr(self,'paused_brain'):
            os.kill(self.paused_brain,signal.SIGCONT)
            self.log('isolated_authority_resumed',pid=self.paused_brain)
        if self.args.scenario=='revoke' and self.signed:
            self.set_isolated_enabled(True)
        if hasattr(self, 'story_task'):
            self.story_task.cancel()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.mic is not None:
            await self.mic.aclose()
        await self.room.disconnect()
        # Query only this signed synthetic room. A log line 'closed' is insufficient.
        if self.signed:
            name=self.signed['room_name']
            assert name.startswith('sn-'+self.creds['device_sn']+'-')
            client=api.LiveKitAPI(url=os.environ['LIVEKIT_URL'], api_key=os.environ['LIVEKIT_API_KEY'], api_secret=os.environ['LIVEKIT_API_SECRET'])
            try:
                for _ in range(60):
                    reply=await client.room.list_rooms(api.ListRoomsRequest(names=[name]))
                    if not reply.rooms:
                        self.log('room_api_absent', room=name)
                        break
                    await asyncio.sleep(.1)
                else:
                    self.log('cleanup_fallback', room=name)
                    await client.room.delete_room(api.DeleteRoomRequest(room=name))
                    raise AssertionError('Worker failed automatic room deletion; test cleaned only own room')
            finally:
                await client.aclose()


async def main(args):
    probe = Probe(args)
    result = {'scenario': args.scenario, 'entry_style': args.entry_style, 'passed': False, 'boundaries': {'RTC': 'real shared SFU unique agent/room', 'job_orchestrator': 'real candidate test-feature binary', 'Brain_authority': 'real isolated SQLite/clock/routes/registration', 'text_provider': 'deterministic synthetic', 'ASR_TTS': 'real provider, synthetic WAV input', 'Android': 'software substitute'}}
    try:
        await probe.run()
        result['passed'] = True
    except Exception as error:
        probe.log('failure', error=str(error))
        result['error'] = str(error)
    finally:
        try:
            await probe.close()
        except Exception as error:
            result['passed']=False
            result['cleanup_error']=str(error)
            probe.log('cleanup_failure', error=str(error))
        result.update(events=probe.events, captions=probe.captions, audio=probe.audio, signed_binding={k: probe.signed[k] for k in ['room_name','session_id','trace_id','expected_agent_name']} if probe.signed else None)
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    return 0 if result['passed'] else 1

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--credentials', required=True)
    parser.add_argument('--mic-publish-delay-ms', type=int, default=0)
    parser.add_argument('--entry-style', choices=['full', 'wake-tail'], default='full',
                        help='wake-tail needs synthetic wake.wav and enter_tail.wav; unsupported entry remains a failing result')
    parser.add_argument('--base', default='http://127.0.0.1:18738')
    parser.add_argument('--fixtures', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--scenario', choices=['normal', 'barge', 'missing_ready', 'proposal_timeout', 'disconnect', 'revoke', 'lease_timeout'], default='normal')
    raise SystemExit(asyncio.run(main(parser.parse_args())))
