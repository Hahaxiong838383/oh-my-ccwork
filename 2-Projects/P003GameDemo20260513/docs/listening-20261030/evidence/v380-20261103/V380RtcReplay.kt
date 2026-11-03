package com.futurus.p003.launcher.voice.livekit

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import java.io.File

/** Offline replay of actual received packets through unmodified v380 controller.
 * Trust metadata is checked by the producer probe and reviewed separately.
 * Probe-only query/retransmission commands are not claimed as Android-generated.
 */
@OptIn(ExperimentalCoroutinesApi::class)
fun main(args: Array<String>) = runTest {
    require(args.size == 1)
    val root = JsonParser.parseString(File(args[0]).readText()).asJsonObject
    val binding = root.getAsJsonObject("signed_binding")
    val trace = binding.get("trace_id").asString
    val session = binding.get("session_id").asString
    check(root.get("passed").asBoolean) { "producer scenario failed; cannot certify replay" }
    val allEvents = root.getAsJsonArray("events").map { it.asJsonObject }
    val summaryIndex = allEvents.indexOfFirst { it.get("event").asString == "summary" }
    require(summaryIndex >= 0) { "no successful scenario boundary" }
    // Exclude client cleanup disconnect: only server disconnect during the scenario counts.
    val events = allEvents.take(summaryIndex + 1)
    val firstProposal = events.firstOrNull { it.get("event").asString == "data_received" &&
        it.getAsJsonObject("value")?.get("type")?.asString == "listening.proposal" }
    require(firstProposal != null) { "no real proposal: not a voice-entry replay" }
    val participant = firstProposal.getAsJsonObject("value").getAsJsonObject("payload").get("participant").asString
    val codec = VoiceControlCodec { 1000 + testScheduler.currentTime }
    val generated = mutableListOf<VoiceControlMessage>()
    val states = mutableListOf<String>()
    val recoveries = mutableListOf<String>()
    var allocated = 0L
    var disconnects = 0
    var controls = 0
    var injectedQuerySequences = 0
    val controller = ListeningVoiceController(this, codec,
        publisher = { bytes -> val m = codec.decode(bytes); generated += m; allocated = maxOf(allocated,m.seq ?: 0) },
        silenceNow = {}, localAudioGate = ListeningLocalAudioGate { true },
        onState = { _, state, reason -> states += "$state:$reason" },
        onRecoveryRequired = { _, reason -> recoveries += reason }, diagnostic = {})
    controller.bind(trace, session, participant, ListeningVoiceContract(1,
        ListeningVoiceContract.MODE_CAPABILITY, 1, ListeningVoiceContract.VOICE_CONTROL_CAPABILITY))
    for ((i, event) in events.withIndex()) {
        when (event.get("event").asString) {
            "data_received" -> {
                if (event.get("topic")?.asString != "control") continue
                val value = event.getAsJsonObject("value")
                val message = codec.decode(value.toString().toByteArray())
                if (!message.type.startsWith("listening.")) continue
                if (message.type == "listening.proposal") {
                    val p = message.payload
                    val sent = events.drop(i + 1).firstOrNull {
                        it.get("event").asString == "control_sent" &&
                        it.get("type")?.asString == "listening."+p.get("action").asString &&
                        it.getAsJsonObject("payload")?.get("proposal_id")?.asString == p.get("proposal_id").asString
                    }
                    require(sent != null || root.get("scenario").asString == "proposal_timeout") { "missing accepted proposal command" }
                    // Probe inserts state queries before proposals, unlike Android. Reserve their
                    // sequence slots without changing recorded downlink request_id/command_seq.
                    val target = sent?.get("seq")?.asLong ?: (allocated + 1)
                    while (allocated + 1 < target) {
                        val reserve = codec.decode(codec.encodeSignal(trace,"listening.state","control",JsonObject()))
                        allocated = reserve.seq!!; injectedQuerySequences++
                    }
                }
                controller.onTrustedControl(message); runCurrent(); controls++
            }
            "disconnected" -> { controller.reset(); disconnects++ }
        }
    }
    val realCommands = events.filter { it.get("event").asString == "control_sent" }
    for (g in generated) {
        val match = realCommands.any { it.get("type").asString == g.type && it.get("seq").asLong == g.seq &&
            it.getAsJsonObject("payload") == g.payload }
        // missing_ready deliberately drops a legitimately generated local_ready at transport.
        val intentionallyDropped = (root.get("scenario").asString == "missing_ready" && g.type == "listening.local_ready") ||
            (root.get("scenario").asString == "proposal_timeout" && g.type == "listening.enter")
        check(match || intentionallyDropped) {
            "controller output unmatched by RTC transcript: ${g.type}/${g.seq}"
        }
    }
    val normalExit = states.any { it == "NORMAL:exit_completed" }
    check(normalExit || disconnects > 0) { "no consumed exit or standard disconnection" }
    check(!controller.isActive()) { "client controller remains active" }
    val out = JsonObject().apply {
        addProperty("pass",true);addProperty("trace",trace);addProperty("received_controls_replayed",controls)
        addProperty("controller_generated_commands",generated.size);addProperty("normal_exit_consumed",normalExit)
        addProperty("disconnect_reset_observed",disconnects);addProperty("probe_query_sequence_slots",injectedQuerySequences)
        addProperty("intentional_transport_drop_scenario",root.get("scenario").asString in listOf("missing_ready","proposal_timeout"));
        addProperty("active",controller.isActive());addProperty("states",states.joinToString(";"))
        addProperty("recoveries",recoveries.joinToString(";"))
        addProperty("limits","recorded packet order, not realtime timers/audio/UI; trust verified separately; probe query slots reserved; reset calls outer disconnected path")
    }
    println(out)
    controller.reset()
}
