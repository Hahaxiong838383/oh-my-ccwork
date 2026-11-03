package com.futurus.p003.launcher.voice.livekit

import com.google.gson.JsonObject
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class V380ExitConsumerReviewTest {
    @Test fun unmatchedTerminalAckAndNoPollingAfterCompletedEnter() = runTest {
        val f = Fixture(this)
        val enter = f.completeEnter("enter", 1)
        val before = f.published.size
        f.controller.onTrustedControl(f.ack(enter, "completed", "paused", 2))
        runCurrent()
        advanceTimeBy(60_000); runCurrent()
        assertEquals(before, f.published.size)
        assertEquals(ListeningVoiceState.LISTENING, f.states.last())
        assertTrue(f.recoveries.isEmpty())
        f.controller.reset() // Exact controller reset invoked by outer RTC disconnect path; no real RTC assertion.
        assertFalse(f.controller.isActive())
    }
    @Test fun workerRejectedIsIgnoredUntilSixSecondRecovery() = runTest {
        val f = Fixture(this)
        f.controller.onTrustedControl(f.proposal("enter", "enter", 0, "story")); runCurrent()
        f.controller.onTrustedControl(f.ack(f.decoded(0), "rejected", "normal", 0)); runCurrent()
        assertTrue(f.recoveries.isEmpty())
        advanceTimeBy(3_000); runCurrent()
        assertTrue(f.published.map(f.codec::decode).any { it.type == "listening.state" })
        advanceTimeBy(3_000); runCurrent()
        assertEquals(listOf("state_timeout"), f.recoveries)
    }
    @Test fun clientFailedTriggersImmediateRecovery() = runTest {
        val f = Fixture(this)
        f.controller.onTrustedControl(f.proposal("enter", "enter", 0, "story")); runCurrent()
        f.controller.onTrustedControl(f.ack(f.decoded(0), "failed", "normal", 0)); runCurrent()
        assertEquals(listOf("worker_failed"), f.recoveries)
        assertEquals(ListeningVoiceState.PAUSED, f.states.last())
    }
    @Test fun sharingRejectedButShareAcceptedByExactClient() = runTest {
        val f = Fixture(this)
        f.controller.onTrustedControl(f.proposal("sharing", "enter", 0, "sharing")); runCurrent()
        assertTrue(f.published.isEmpty())
        f.controller.onTrustedControl(f.proposal("share", "enter", 0, "share")); runCurrent()
        assertEquals("share", f.decoded(0).payload.get("scene").asString)
        f.controller.reset()
    }
    @Test fun workerFeedbackActiveSnapshotRequiresRecovery() = runTest {
        val f = Fixture(this)
        f.controller.onTrustedControl(f.proposal("enter", "enter", 0, "story")); runCurrent()
        advanceTimeBy(3_000); runCurrent()
        val query = f.published.map(f.codec::decode).last { it.type == "listening.state" }
        f.controller.onTrustedControl(f.ack(query, "completed", "feedback_active", 2)); runCurrent()
        assertEquals(listOf("state_invalid"), f.recoveries)
    }
    @Test fun completionBeforeLocalReadyIsRejectedByExactController() = runTest {
        val f = Fixture(this)
        f.controller.onTrustedControl(f.proposal("enter", "enter", 0, "story")); runCurrent()
        f.controller.onTrustedControl(f.ack(f.decoded(0), "completed", "listening", 1)); runCurrent()
        assertEquals(listOf("completion_state_invalid"), f.recoveries)
        assertEquals(ListeningVoiceState.PAUSED, f.states.last())
    }
    private class Fixture(
        private val scope: TestScope,
        enabled: Boolean = true,
    ) {
        val codec = VoiceControlCodec { scope.testScheduler.currentTime + 1_000 }
        val published = mutableListOf<ByteArray>()
        val states = mutableListOf<ListeningVoiceState>()
        val recoveries = mutableListOf<String>()
        var silenceNow = false
        var localDrainCount = 0
        val controller = ListeningVoiceController(
            scope = scope,
            codec = codec,
            publisher = { published += it.copyOf() },
            silenceNow = { silenceNow = true },
            localAudioGate = ListeningLocalAudioGate {
                localDrainCount++
                true
            },
            onState = { _, state, _ -> states += state },
            onRecoveryRequired = { _, reason -> recoveries += reason },
            diagnostic = {},
        ).also { it.bind(TRACE, SESSION, PARTICIPANT, if (enabled) CONTRACT else null) }

        fun proposal(id: String, action: String, epoch: Long, scene: String?): VoiceControlMessage =
            VoiceControlMessage(
                traceId = TRACE,
                tsMs = 1_000,
                src = "worker",
                type = "listening.proposal",
                lane = "control",
                seq = null,
                payload = JsonObject().apply {
                    addProperty("version", 1)
                    addProperty("proposal_id", id)
                    addProperty("session_id", SESSION)
                    addProperty("participant", PARTICIPANT)
                    addProperty("mode_epoch", epoch)
                    addProperty("action", action)
                    scene?.let { addProperty("scene", it) }
                    addProperty("ttl_ms", 3_000)
                },
            )

        fun ack(command: VoiceControlMessage, stage: String, state: String, epoch: Long): VoiceControlMessage =
            VoiceControlMessage(
                traceId = command.traceId,
                tsMs = 1_001,
                src = "worker",
                type = "listening.ack",
                lane = "control",
                seq = null,
                payload = JsonObject().apply {
                    addProperty("version", 1)
                    addProperty("request_id", command.payload.get("request_id").asString)
                    addProperty("command_seq", command.seq)
                    addProperty("stage", stage)
                    addProperty("state", state)
                    addProperty("mode_epoch", epoch)
                },
            )

        fun decoded(index: Int): VoiceControlMessage = codec.decode(published[index])

        suspend fun completeEnter(id: String, epoch: Long): VoiceControlMessage {
            controller.onTrustedControl(proposal(id, "enter", 0, "story"))
            scope.runCurrent()
            val enter = decoded(published.lastIndex)
            controller.onTrustedControl(ack(enter, "received", "entering", epoch))
            scope.runCurrent()
            controller.onTrustedControl(ack(enter, "completed", "listening", epoch))
            scope.runCurrent()
            return enter
        }
    }

    private companion object {
        const val TRACE = "trace-listening-1"
        const val TRACE_2 = "trace-listening-2"
        const val SESSION = "session-listening-1"
        const val SESSION_2 = "session-listening-2"
        const val PARTICIPANT = "dev-BJP00326060100200003"
        val CONTRACT = ListeningVoiceContract(
            1,
            ListeningVoiceContract.MODE_CAPABILITY,
            1,
            ListeningVoiceContract.VOICE_CONTROL_CAPABILITY,
        )
    }
}
